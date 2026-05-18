import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Integ from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as fs from 'fs';
import * as path from 'path';

export interface NacosClusterStackProps extends cdk.StackProps {
  /** 既有 VPC ID */
  vpcId: string;
  /** Nacos 节点要部署的子网（建议 3 个跨 AZ 的私有子网）*/
  subnetIds: string[];

  /** Aurora MySQL writer endpoint（cluster endpoint）*/
  auroraEndpoint: string;
  /** Nacos 用的数据库名 */
  auroraDbName: string;
  /** Nacos 用的数据库账号 */
  auroraUser: string;
  /** Aurora 密码 secret ARN（Secrets Manager 里存纯密码字符串）*/
  auroraPasswordSecretArn: string;

  /** Nacos token secret key（建议从 SSM Parameter Store SecureString 读取，传 parameter 名）*/
  nacosTokenSecretKeyParameter?: string;
  nacosIdentityKeyParameter?: string;
  nacosIdentityValueParameter?: string;

  /** ASG 容量 */
  desiredCapacity: number;
  minCapacity: number;
  maxCapacity: number;

  /** EC2 规格 */
  instanceType: string;

  /** AMP remote_write URL（可选，留空则不部署 ADOT sidecar）*/
  ampRemoteWriteUrl?: string;

  /** Nacos 版本 */
  nacosVersion: string;

  /** SSH key 名（可选）*/
  keyName?: string;

  /** Aurora SG ID（可选，传了就自动给 Aurora SG 加 inbound 3306 from Nacos cluster SG）*/
  auroraSecurityGroupId?: string;
}

export class NacosClusterStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: NacosClusterStackProps) {
    super(scope, id, props);

    // === 1. 引用既有 VPC ===
    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });

    const subnets = props.subnetIds.map((id, i) =>
      ec2.Subnet.fromSubnetId(this, `Subnet${i}`, id)
    );
    const vpcSubnets: ec2.SubnetSelection = { subnets };

    // === 2. Security Groups ===
    const clusterSg = new ec2.SecurityGroup(this, 'NacosClusterSg', {
      vpc,
      description: 'Nacos cluster nodes',
      allowAllOutbound: true,
    });

    const nlbSg = new ec2.SecurityGroup(this, 'NacosNlbSg', {
      vpc,
      description: 'Nacos internal NLB',
      allowAllOutbound: true,
    });

    // 节点之间互通：8848(server)、9848(client gRPC)、9849(server gRPC)、7848(raft)
    clusterSg.addIngressRule(clusterSg, ec2.Port.tcp(8848), 'Nacos main port (peer)');
    clusterSg.addIngressRule(clusterSg, ec2.Port.tcp(9848), 'gRPC client');
    clusterSg.addIngressRule(clusterSg, ec2.Port.tcp(9849), 'gRPC cluster');
    clusterSg.addIngressRule(clusterSg, ec2.Port.tcp(7848), 'Raft');
    clusterSg.addIngressRule(clusterSg, ec2.Port.tcp(8080), 'Console (peer)');
    clusterSg.addIngressRule(clusterSg, ec2.Port.tcp(9090), 'AddressServer (peer)');

    // NLB -> 节点
    clusterSg.addIngressRule(nlbSg, ec2.Port.tcp(8848), 'NLB to 8848');
    clusterSg.addIngressRule(nlbSg, ec2.Port.tcp(9848), 'NLB to 9848');
    clusterSg.addIngressRule(nlbSg, ec2.Port.tcp(8080), 'NLB to 8080');

    // VPC CIDR -> NLB（默认放开 VPC 内网）
    nlbSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(8848), 'VPC to 8848');
    nlbSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(9848), 'VPC to 9848');
    nlbSg.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(8080), 'VPC to 8080');

    // === Aurora SG: 自動加 inbound 3306（可选，传了 auroraSecurityGroupId 就加）===
    if (props.auroraSecurityGroupId) {
      const auroraSg = ec2.SecurityGroup.fromSecurityGroupId(
        this, 'AuroraSg', props.auroraSecurityGroupId
      );
      auroraSg.addIngressRule(clusterSg, ec2.Port.tcp(3306), 'Nacos cluster to Aurora 3306');
    }

    // === 3. Address Server (Lambda + API Gateway HTTP API) ===
    // Nacos 的 nacos.core.member.lookup.type=address-server 会去 GET 一个 URL 拿 IP 列表（一行一个）
    // 我们用 Lambda 实时查 ASG 实例 IP，避免 ASG 扩缩容时手动维护 cluster.conf
    const addressServerFn = new lambda.Function(this, 'AddressServerFn', {
      runtime: lambda.Runtime.PYTHON_3_12,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(__dirname, 'lambda', 'address-server')),
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      environment: {
        ASG_NAME: '', // 会在 ASG 创建后通过 addEnvironment 补上
      },
      logGroup: new logs.LogGroup(this, 'AddressServerLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    addressServerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'autoscaling:DescribeAutoScalingGroups',
        'ec2:DescribeInstances',
      ],
      resources: ['*'],
    }));

    const addressApi = new apigwv2.HttpApi(this, 'AddressServerApi', {
      apiName: `${id}-address-server`,
      description: 'Returns current Nacos node IPs (one per line) for cluster.address-server lookup',
    });

    addressApi.addRoutes({
      path: '/nacos/serverlist',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integ.HttpLambdaIntegration('AddressIntegration', addressServerFn),
    });

    // API Gateway endpoint，例如 https://abc123.execute-api.us-east-1.amazonaws.com
    // 提取 host，给 userdata 用
    const addressApiHost = cdk.Fn.select(2, cdk.Fn.split('/', addressApi.url!));

    // === 4. EC2 Role ===
    const role = new iam.Role(this, 'NacosNodeRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // 读 Aurora 密码
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue'],
      resources: [props.auroraPasswordSecretArn],
    }));

    // 读 SSM Parameter（鉴权 secret）
    if (props.nacosTokenSecretKeyParameter) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:GetParameters'],
        resources: [
          ...[
            props.nacosTokenSecretKeyParameter,
            props.nacosIdentityKeyParameter,
            props.nacosIdentityValueParameter,
          ]
            .filter(Boolean)
            .map(
              (p) =>
                `arn:aws:ssm:${this.region}:${this.account}:parameter${
                  p!.startsWith('/') ? p : '/' + p
                }`
            ),
        ],
      }));
      // SSM Parameter SecureString 可能用 KMS 加密
      role.addToPolicy(new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `ssm.${this.region}.amazonaws.com`,
          },
        },
      }));
    }

    // 让 EC2 自己能查 ASG（实例自己感知集群成员，备用机制）
    role.addToPolicy(new iam.PolicyStatement({
      actions: ['autoscaling:DescribeAutoScalingGroups', 'ec2:DescribeInstances'],
      resources: ['*'],
    }));

    // 如果配了 AMP，加 RemoteWrite 权限
    if (props.ampRemoteWriteUrl) {
      role.addToPolicy(new iam.PolicyStatement({
        actions: [
          'aps:RemoteWrite',
          'aps:GetSeries',
          'aps:GetLabels',
          'aps:GetMetricMetadata',
        ],
        resources: ['*'],
      }));
    }

    // === 5. UserData ===
    const userDataTemplate = fs.readFileSync(
      path.join(__dirname, '..', 'assets', 'userdata', 'nacos-bootstrap.sh'),
      'utf8'
    );

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      `cat > /tmp/nacos-vars.env <<'NACOS_VARS_EOF'`,
      `NACOS_VERSION="${props.nacosVersion}"`,
      `AURORA_ENDPOINT="${props.auroraEndpoint}"`,
      `AURORA_DB_NAME="${props.auroraDbName}"`,
      `AURORA_USER="${props.auroraUser}"`,
      `AURORA_PASSWORD_SECRET_ARN="${props.auroraPasswordSecretArn}"`,
      `NACOS_TOKEN_SECRET_KEY_PARAM="${props.nacosTokenSecretKeyParameter ?? ''}"`,
      `NACOS_IDENTITY_KEY_PARAM="${props.nacosIdentityKeyParameter ?? ''}"`,
      `NACOS_IDENTITY_VALUE_PARAM="${props.nacosIdentityValueParameter ?? ''}"`,
      `ADDRESS_SERVER_DOMAIN="${addressApiHost}"`,
      `ADDRESS_SERVER_PORT="443"`,
      `ADDRESS_SERVER_URL="/nacos/serverlist"`,
      `ADDRESS_SERVER_USE_TLS="true"`,
      `AMP_REMOTE_WRITE_URL="${props.ampRemoteWriteUrl ?? ''}"`,
      `AWS_REGION_NAME="${this.region}"`,
      `NACOS_VARS_EOF`,
      'chmod 600 /tmp/nacos-vars.env',
      userDataTemplate
    );

    // === 6. Launch Template + ASG ===
    const lt = new ec2.LaunchTemplate(this, 'NacosLaunchTemplate', {
      launchTemplateName: `${id}-nacos-lt`,
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      securityGroup: clusterSg,
      userData,
      keyPair: props.keyName
        ? ec2.KeyPair.fromKeyPairName(this, 'KeyPair', props.keyName)
        : undefined,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(100, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            iops: 3000,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });

    const asg = new autoscaling.AutoScalingGroup(this, 'NacosAsg', {
      vpc,
      vpcSubnets,
      launchTemplate: lt,
      desiredCapacity: props.desiredCapacity,
      minCapacity: props.minCapacity,
      maxCapacity: props.maxCapacity,
      healthChecks: autoscaling.HealthChecks.withAdditionalChecks({
        additionalTypes: [autoscaling.AdditionalHealthCheckType.ELB],
        gracePeriod: cdk.Duration.minutes(5), // Nacos 启动慢，给足时间
      }),
      // 滚动更新策略：一次替换一台，等新节点 InService 后再下一台
      updatePolicy: autoscaling.UpdatePolicy.rollingUpdate({
        maxBatchSize: 1,
        minInstancesInService: props.minCapacity - 1,
        pauseTime: cdk.Duration.minutes(5),
        waitOnResourceSignals: false,
      }),
    });

    // 把 ASG 名字补到 Lambda env
    addressServerFn.addEnvironment('ASG_NAME', asg.autoScalingGroupName);

    // === 7. NLB + Target Groups ===
    const nlb = new elbv2.NetworkLoadBalancer(this, 'NacosNlb', {
      vpc,
      vpcSubnets,
      internetFacing: false,
      securityGroups: [nlbSg],
      crossZoneEnabled: true,
    });

    // 8848 - Server 主端口（TCP 健康检查，详见部署文档 §7.1）
    const tg8848 = new elbv2.NetworkTargetGroup(this, 'Tg8848', {
      vpc,
      port: 8848,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        protocol: elbv2.Protocol.TCP,
        port: '8848',
        interval: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // 9848 - gRPC client
    const tg9848 = new elbv2.NetworkTargetGroup(this, 'Tg9848', {
      vpc,
      port: 9848,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        protocol: elbv2.Protocol.TCP,
        port: '9848',
        interval: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    // 8080 - Console（HTTP 健康检查）
    const tg8080 = new elbv2.NetworkTargetGroup(this, 'Tg8080', {
      vpc,
      port: 8080,
      protocol: elbv2.Protocol.TCP,
      targetType: elbv2.TargetType.INSTANCE,
      healthCheck: {
        protocol: elbv2.Protocol.HTTP,
        port: '8080',
        path: '/v3/console/health/readiness',
        interval: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 2,
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    asg.attachToNetworkTargetGroup(tg8848);
    asg.attachToNetworkTargetGroup(tg9848);
    asg.attachToNetworkTargetGroup(tg8080);

    nlb.addListener('Listener8848', {
      port: 8848,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [tg8848],
    });
    nlb.addListener('Listener9848', {
      port: 9848,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [tg9848],
    });
    nlb.addListener('Listener8080', {
      port: 8080,
      protocol: elbv2.Protocol.TCP,
      defaultTargetGroups: [tg8080],
    });

    // === 8. Outputs ===
    new cdk.CfnOutput(this, 'NlbDnsName', {
      value: nlb.loadBalancerDnsName,
      description: 'Internal NLB DNS name. SDK should connect with serverAddr=<dns>:8848',
    });

    new cdk.CfnOutput(this, 'AddressServerUrl', {
      value: addressApi.url ?? '',
      description: 'Address server URL (Nacos nodes use this to discover peers)',
    });

    new cdk.CfnOutput(this, 'AsgName', {
      value: asg.autoScalingGroupName,
      description: 'ASG name (use to scale: aws autoscaling set-desired-capacity ...)',
    });

    new cdk.CfnOutput(this, 'ClusterSgId', {
      value: clusterSg.securityGroupId,
      description: 'Cluster Security Group ID. Add to Aurora SG inbound 3306 to allow Nacos -> Aurora.',
    });

    new cdk.CfnOutput(this, 'ConsoleUrl', {
      value: `http://${nlb.loadBalancerDnsName}:8080/index.html`,
      description: 'Nacos Console URL (first visit will force admin password setup)',
    });
  }
}
