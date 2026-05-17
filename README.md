# Nacos CDK

> **目标**：用 AWS CDK 一键部署 Nacos 3.1.1 集群（EC2 + ASG + 内网 NLB），支持横向弹性扩缩。
>
> **不包含**：Aurora MySQL、AMP、AMG —— 这些由客户预先部署，本 CDK 通过参数引用。

---

## 架构

```
                       ┌──────────────────┐
                       │   Client (SDK)   │
                       │  8848/9848/8080  │
                       └────────┬─────────┘
                                │
                       ┌────────▼─────────┐
                       │  Internal NLB    │
                       │  (3 listener)    │
                       └────────┬─────────┘
                                │
                  ┌─────────────┼─────────────┐
                  │             │             │
            ┌─────▼─────┐ ┌─────▼─────┐ ┌─────▼─────┐
            │   ASG 节点 1   │ │   ASG 节点 2   │ │   ASG 节点 3   │   ← 默认 3 个，可扩
            │ Nacos 3.1.1   │ │              │ │              │
            └─────┬─────┘ └─────┬─────┘ └─────┬─────┘
                  │             │             │
                  └─────────────┼─────────────┘
                                │
              ┌────────────────────────────────┐
              │  地址服务（API GW + Lambda）    │  ← 节点定期 GET 拿活跃节点 IP 列表
              │  /nacos/serverlist             │
              └────────────────────────────────┘
                                │
              ┌────────────────────────────────┐
              │  Aurora MySQL (客户预先部署)     │
              │  AMP / AMG (客户预先部署，可选)  │
              └────────────────────────────────┘
```

### 关键设计

- **ASG**：3 节点跨 3 AZ，启动慢（5 分钟 health check grace），滚动更新一次 1 台
- **集群成员发现 = `address-server` 模式**：每个 Nacos 节点定期 GET `https://<api-gw-host>/nacos/serverlist`，Lambda 实时返回 ASG InService 实例 IP 列表。**ASG 扩缩容时无需手动改 cluster.conf。**
- **NLB 健康检查**：8848/9848 用 TCP，8080 用 HTTP `/v3/console/health/readiness`（Nacos 3.x 实测，详见踩坑记录）
- **JVM DNS TTL=5s + HikariCP maxLifetime=60s**：Aurora failover RTO ≈ 1 分钟（2026-05-17 实测验证）
- **systemd `ExecStartPre=chown -R nacos:nacos /opt/nacos`**：兜底防 sudo 操作把日志/配置弄成 root owner 导致启动循环（实测踩坑）

---

## 前置条件（CDK 之前需要准备好）

### 1. VPC + 私有子网

需要既有 VPC，建议至少 3 个跨 AZ 的私有子网。记下：
- `VPC_ID`（如 `vpc-xxxxxxxx`）
- `SUBNET_IDS`（如 `subnet-aaa,subnet-bbb,subnet-ccc`，**逗号分隔**）

### 2. Aurora MySQL（客户预先部署）

```bash
# 推荐配置：Aurora MySQL 3.10，db.r7g.large，跨 AZ Replica
# 已经初始化好 nacos schema：https://raw.githubusercontent.com/alibaba/nacos/refs/heads/master/distribution/conf/mysql-schema.sql
```

记下：
- Cluster writer endpoint（如 `nacos-aurora-prod.cluster-xxxxxx.us-east-1.rds.amazonaws.com`）
- 数据库名（默认 `nacos_prod`）
- Nacos 用账号（如 `nacos`，权限：`SELECT, INSERT, UPDATE, DELETE`）

把密码存进 Secrets Manager：

```bash
aws secretsmanager create-secret \
  --region us-east-1 \
  --name nacos/aurora/password \
  --secret-string "你的强密码"
```

记下返回的 `ARN`。

### 3.（推荐）Nacos 鉴权 Secret 存进 SSM Parameter Store

为了 3 台节点 secret 一致 + 重建时不变，强烈建议提前用 SSM SecureString 存好：

```bash
# Token Secret Key（≥ 32 字节 base64）
aws ssm put-parameter --region us-east-1 \
  --name /nacos/auth/token-secret-key \
  --type SecureString \
  --value "$(openssl rand -base64 32)"

# Identity Key
aws ssm put-parameter --region us-east-1 \
  --name /nacos/auth/identity-key \
  --type SecureString \
  --value "$(openssl rand -hex 16)"

# Identity Value
aws ssm put-parameter --region us-east-1 \
  --name /nacos/auth/identity-value \
  --type SecureString \
  --value "$(openssl rand -hex 16)"
```

> ⚠️ 不传这三个参数也能跑（CDK 会用临时随机值），但**节点替换时密钥会变**，所有客户端 token 失效。生产**必须**传。

### 4.（可选）AMP Workspace

如果要监控，提前建好 AMP，记下 `remote_write URL`：
```
https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-xxxxxxxx/api/v1/remote_write
```

---

## 部署步骤

### 1. 装依赖

```bash
git clone https://github.com/f1shb0t/nacos-cdk.git
cd nacos-cdk
npm install
```

### 2. CDK bootstrap（每个 region/account 只用做一次）

```bash
export AWS_REGION=us-east-1
npx cdk bootstrap aws://${AWS_ACCOUNT_ID}/${AWS_REGION}
```

### 3. 参数确认 → 部署

```bash
npx cdk deploy \
  -c vpcId=vpc-xxxxxxxx \
  -c subnetIds=subnet-aaa,subnet-bbb,subnet-ccc \
  -c auroraEndpoint=nacos-aurora-prod.cluster-xxxxxx.us-east-1.rds.amazonaws.com \
  -c auroraDbName=nacos_prod \
  -c auroraUser=nacos \
  -c auroraPasswordSecretArn=arn:aws:secretsmanager:us-east-1:111122223333:secret:nacos/aurora/password-XXXXXX \
  -c nacosTokenSecretKeyParameter=/nacos/auth/token-secret-key \
  -c nacosIdentityKeyParameter=/nacos/auth/identity-key \
  -c nacosIdentityValueParameter=/nacos/auth/identity-value \
  -c desiredCapacity=3 \
  -c minCapacity=3 \
  -c maxCapacity=6 \
  -c instanceType=c7i.2xlarge \
  -c keyName=your-keypair \
  -c ampRemoteWriteUrl=https://aps-workspaces.us-east-1.amazonaws.com/workspaces/ws-xxxxxxxx/api/v1/remote_write
```

支持的所有 context 参数：

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `vpcId` | ✅ | - | 既有 VPC |
| `subnetIds` | ✅ | - | 逗号分隔，建议 3 个跨 AZ 私有子网 |
| `auroraEndpoint` | ✅ | - | Aurora cluster writer endpoint |
| `auroraDbName` | ❌ | `nacos_prod` | 数据库名 |
| `auroraUser` | ✅ | - | DB 账号 |
| `auroraPasswordSecretArn` | ✅ | - | Secrets Manager ARN（存 password 字符串）|
| `nacosTokenSecretKeyParameter` | ⭐ 强烈建议 | 临时随机值 | SSM SecureString 参数名 |
| `nacosIdentityKeyParameter` | ⭐ 强烈建议 | 临时随机值 | 同上 |
| `nacosIdentityValueParameter` | ⭐ 强烈建议 | 临时随机值 | 同上 |
| `desiredCapacity` | ❌ | `3` | ASG 期望容量 |
| `minCapacity` | ❌ | `3` | ASG 最小 |
| `maxCapacity` | ❌ | `6` | ASG 最大 |
| `instanceType` | ❌ | `c7i.2xlarge` | EC2 规格 |
| `ampRemoteWriteUrl` | ❌ | 留空 | 传了就装 ADOT sidecar 上报 AMP |
| `nacosVersion` | ❌ | `3.1.1` | Nacos 版本 |
| `keyName` | ❌ | 不绑 | EC2 SSH key |
| `region` | ❌ | `us-east-1` | 部署 region |
| `stackName` | ❌ | `NacosCluster` | CFN stack 名 |

### 4. 部署完成后

CDK Outputs：

```
NlbDnsName        = nacos-internal-nlb-xxxxxxxx.elb.us-east-1.amazonaws.com
AddressServerUrl  = https://abc123.execute-api.us-east-1.amazonaws.com/
AsgName           = NacosCluster-NacosAsg-xxxxxxxx
ClusterSgId       = sg-xxxxxxxx
ConsoleUrl        = http://nacos-internal-nlb-xxxxxxxx.elb.us-east-1.amazonaws.com:8080/index.html
```

### 5. ⚠️ 必须手动做的：把 ClusterSG 加到 Aurora SG inbound

CDK 不能改你客户的 Aurora SG。你需要手动加一条 inbound：

```bash
aws ec2 authorize-security-group-ingress \
  --region us-east-1 \
  --group-id <Aurora SG> \
  --protocol tcp --port 3306 \
  --source-group <ClusterSgId from CDK output>
```

### 6. 初始化管理员密码

第一次访问 Console（`http://<NlbDnsName>:8080/index.html`），会强制要求设置 `nacos` 管理员的新密码（≥8 位）。

---

## 横向扩缩容

```bash
# 扩到 5 个节点
aws autoscaling set-desired-capacity \
  --region us-east-1 \
  --auto-scaling-group-name <AsgName> \
  --desired-capacity 5

# 验证：等 5-10 分钟新节点 InService
aws autoscaling describe-auto-scaling-groups \
  --region us-east-1 \
  --auto-scaling-group-names <AsgName> \
  --query 'AutoScalingGroups[0].Instances[*].[InstanceId,LifecycleState]' \
  --output table
```

新节点起来后会：
1. 通过 `address-server` 自动发现既有节点
2. 加入集群（raft 协议自动同步状态）
3. 自动注册到 NLB target group

无需手动改任何配置。

---

## 验证

### 集群状态

```bash
# 拿 token
TOKEN=$(curl -s -X POST 'http://<NlbDnsName>:8848/nacos/v3/auth/user/login' \
  -d 'username=nacos' -d 'password=<你设置的密码>' | jq -r .accessToken)

# 看集群成员（应该看到 N 个 UP 节点）
curl -H "accessToken: ${TOKEN}" \
  http://<NlbDnsName>:8080/v3/console/core/cluster/nodes | jq
```

### Nacos 节点登录调试

通过 SSM Session Manager（节点已附带 `AmazonSSMManagedInstanceCore`）：

```bash
aws ssm start-session --region us-east-1 --target i-xxxxxxxxxxxxxxxxx

# 进了节点后
sudo systemctl status nacos
sudo tail -f /opt/nacos/logs/nacos.log
sudo tail -f /opt/nacos/logs/alipay-jraft.log    # leader 选举日志
```

---

## 销毁

```bash
npx cdk destroy
```

> ⚠️ 不会删除你预先部署的 Aurora / AMP / Secrets Manager / SSM Parameter Store —— 需要手动清理。

---

## 设计注意事项

### Q: 为什么不用 cluster.conf 静态文件？

A: ASG 的实例 IP 是动态的，每次替换实例 IP 就变。如果用静态 cluster.conf，扩缩容/实例替换都得手动改 3 台节点的配置，违背了"自动化"初衷。

`address-server` 是 Nacos 官方支持的动态成员发现模式：节点定期 GET 一个 URL 拿当前活跃节点 IP，由这个 URL 背后的服务（这里是 Lambda）实时反映 ASG 状态。

### Q: 为什么用 API Gateway + Lambda 而不是单独跑一台 address-server？

A: 不用维护额外的 EC2/ECS，serverless 自动 HA，成本接近 0（Nacos 节点 GET 频率 5 秒一次 × N 节点远低于免费额度）。

### Q: NLB 健康检查为什么不直接用 HTTP /actuator/health？

A: Nacos 3.x 默认 actuator 只暴露 `prometheus`（不含 `health`），用 HTTP `/actuator/health` 会一直 unhealthy。8848/9848 用 TCP，8080 用 `/v3/console/health/readiness`。详见踩坑记录。

### Q: leader 节点替换会怎样？

A: ASG 替换实例时，leader 节点终止 → 剩余节点 5-10s 内通过 raft 重新选举出新 leader。客户端写入有 5-10s 短暂不可用，符合 Aurora failover 的同等 SLO。

---

## 文档

- [Nacos 3.1.1.0 集群部署文档（飞书）](https://hcnzdl3yqzo0.feishu.cn/docx/ZflMdartLot1C7xvubJcnNvHnBg) —— 详细的手动部署 + 踩坑记录
- [Nacos 集群高可用测试方案（飞书）](https://hcnzdl3yqzo0.feishu.cn/docx/TUGrd2ZynoIminxpF4ocUB2knhh) —— HA 测试场景 + 配套压测代码

---

**作者**：小龙 🐉 for Yuri  **基于**：手动部署文档 v1.17（2026-05-17 实测验证版）
