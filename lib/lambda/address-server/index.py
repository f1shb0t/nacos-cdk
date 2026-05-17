"""
Nacos Address Server (Lambda + API Gateway HTTP API)

Nacos 节点配置 nacos.core.member.lookup.type=address-server 后，会定期 GET 这个 endpoint
拿当前所有节点 IP（一行一个）。这样 ASG 扩缩容时，无需手动维护 cluster.conf。

用 ASG 当前 InService 实例的私有 IP 列表回应。
"""
import os
import boto3

ASG_NAME = os.environ['ASG_NAME']
REGION = os.environ.get('AWS_REGION', 'us-east-1')

asg_client = boto3.client('autoscaling', region_name=REGION)
ec2_client = boto3.client('ec2', region_name=REGION)


def get_inservice_ips():
    """查 ASG 当前 InService 实例的私网 IP 列表。"""
    asg_resp = asg_client.describe_auto_scaling_groups(AutoScalingGroupNames=[ASG_NAME])
    if not asg_resp['AutoScalingGroups']:
        return []

    instances = asg_resp['AutoScalingGroups'][0]['Instances']
    inservice = [
        i['InstanceId']
        for i in instances
        if i.get('LifecycleState') == 'InService'
    ]
    if not inservice:
        return []

    ec2_resp = ec2_client.describe_instances(InstanceIds=inservice)
    ips = []
    for reservation in ec2_resp['Reservations']:
        for inst in reservation['Instances']:
            ip = inst.get('PrivateIpAddress')
            if ip:
                ips.append(ip)
    return sorted(ips)


def handler(event, context):
    """
    返回纯文本，每行一个 IP:port，例如：
        10.0.1.10:8848
        10.0.2.10:8848
        10.0.3.10:8848

    Nacos 默认期望端口部分，address.server.port 在 application.properties 设置。
    我们这里直接返回 IP，让 Nacos 自己拼端口（更通用）。
    """
    try:
        ips = get_inservice_ips()
        body = '\n'.join(ips) + '\n' if ips else ''
        return {
            'statusCode': 200,
            'headers': {
                'Content-Type': 'text/plain; charset=utf-8',
                'Cache-Control': 'no-cache',
            },
            'body': body,
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'headers': {'Content-Type': 'text/plain; charset=utf-8'},
            'body': f'error: {e}\n',
        }
