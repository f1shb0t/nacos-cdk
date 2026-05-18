#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NacosClusterStack } from '../lib/nacos-cluster-stack';

const app = new cdk.App();

// === 参数读取（context > env > 默认值）===
const ctx = (key: string, def?: string): string | undefined =>
  app.node.tryGetContext(key) ?? process.env[key.toUpperCase().replace(/[-:]/g, '_')] ?? def;

const ctxRequired = (key: string): string => {
  const v = ctx(key);
  if (!v) throw new Error(`Missing required context: -c ${key}=<value> (or env ${key.toUpperCase().replace(/[-:]/g, '_')})`);
  return v;
};

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: ctx('region', process.env.CDK_DEFAULT_REGION || 'us-east-1'),
};

new NacosClusterStack(app, ctx('stackName', 'NacosCluster')!, {
  env,
  description: 'Nacos 3.1.1 cluster (EC2 + ASG + NLB + Address Server). Aurora/AMP/AMG provided externally.',

  // === VPC ===
  vpcId: ctxRequired('vpcId'),
  subnetIds: ctxRequired('subnetIds').split(',').map((s) => s.trim()),

  // === Aurora（客户预先准备好）===
  auroraEndpoint: ctxRequired('auroraEndpoint'),
  auroraDbName: ctx('auroraDbName', 'nacos_prod')!,
  auroraUser: ctxRequired('auroraUser'),
  auroraPasswordSecretArn: ctxRequired('auroraPasswordSecretArn'),

  // === Nacos 鉴权密钥（建议提前用 Secrets Manager 存好，传 ARN 进来）===
  nacosTokenSecretKeyParameter: ctx('nacosTokenSecretKeyParameter'),
  nacosIdentityKeyParameter: ctx('nacosIdentityKeyParameter'),
  nacosIdentityValueParameter: ctx('nacosIdentityValueParameter'),

  // === ASG 容量 ===
  desiredCapacity: parseInt(ctx('desiredCapacity', '3')!, 10),
  minCapacity: parseInt(ctx('minCapacity', '3')!, 10),
  maxCapacity: parseInt(ctx('maxCapacity', '6')!, 10),

  // === 实例规格 ===
  instanceType: ctx('instanceType', 'c7i.2xlarge')!,

  // === 监控（可选，留空则不配 ADOT）===
  ampRemoteWriteUrl: ctx('ampRemoteWriteUrl'),

  // === Nacos 版本 ===
  nacosVersion: ctx('nacosVersion', '3.1.1')!,

  // === SSH key（可选）===
  keyName: ctx('keyName'),

  // === Aurora SG（可选，传了就自动加 inbound 3306 规则，不用手动加）===
  auroraSecurityGroupId: ctx('auroraSecurityGroupId'),

  // === 鉴权开关（默认 true=开启鉴权；测试/演示时可设 false 跳过）===
  authEnabled: ctx('authEnabled', 'true')!.toLowerCase() !== 'false',
});

app.synth();
