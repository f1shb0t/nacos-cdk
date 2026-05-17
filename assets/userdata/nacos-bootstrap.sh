#!/bin/bash
# Nacos 节点 bootstrap 脚本（由 CDK userdata 注入运行）
#
# 功能：
#   1) 装 JDK 17 + 工具
#   2) 创建 nacos 用户
#   3) 下载 Nacos 3.x，解包到 /opt/nacos
#   4) 从 SSM Parameter / Secrets Manager 读取敏感配置
#   5) 写 application.properties（含 address-server 模式 + Aurora failover 配置）
#   6) 写 startup.sh JVM 参数（DNS TTL = 5）
#   7) 创建 systemd 服务（含 ExecStartPre=chown 兜底）
#   8) 启动 Nacos
#
# 期望在 userdata 之前已经写入 /tmp/nacos-vars.env，包含：
#   NACOS_VERSION
#   AURORA_ENDPOINT / AURORA_DB_NAME / AURORA_USER / AURORA_PASSWORD_SECRET_ARN
#   NACOS_TOKEN_SECRET_KEY_PARAM / NACOS_IDENTITY_KEY_PARAM / NACOS_IDENTITY_VALUE_PARAM (可选)
#   ADDRESS_SERVER_DOMAIN / ADDRESS_SERVER_PORT / ADDRESS_SERVER_URL / ADDRESS_SERVER_USE_TLS
#   AMP_REMOTE_WRITE_URL (可选)
#   AWS_REGION_NAME

set -euxo pipefail
exec > >(tee -a /var/log/nacos-bootstrap.log) 2>&1

echo "=== Nacos bootstrap started: $(date) ==="

# shellcheck disable=SC1091
. /tmp/nacos-vars.env

# === 1. 系统准备 ===
dnf install -y java-17-amazon-corretto wget tar unzip jq

useradd -m -s /bin/bash nacos || true

# === 2. 下载 Nacos ===
cd /opt
if [ ! -d nacos ]; then
    NACOS_TGZ="nacos-server-${NACOS_VERSION}.tar.gz"
    wget -q "https://github.com/alibaba/nacos/releases/download/${NACOS_VERSION}/${NACOS_TGZ}"
    tar -xzf "${NACOS_TGZ}"
    rm -f "${NACOS_TGZ}"
fi

# === 3. 拉敏感配置 ===
# Aurora 密码（必传）
DB_PASSWORD=$(aws secretsmanager get-secret-value \
    --region "${AWS_REGION_NAME}" \
    --secret-id "${AURORA_PASSWORD_SECRET_ARN}" \
    --query SecretString --output text)

# 鉴权 secret（可选）：如果传了 SSM Parameter 名就拉，没传就用默认（HA 测试场景可接受）
fetch_param() {
    local pname="$1"
    [ -z "${pname}" ] && return 0
    aws ssm get-parameter \
        --region "${AWS_REGION_NAME}" \
        --name "${pname}" \
        --with-decryption \
        --query 'Parameter.Value' --output text 2>/dev/null || echo ""
}

NACOS_TOKEN_KEY=$(fetch_param "${NACOS_TOKEN_SECRET_KEY_PARAM}")
NACOS_ID_KEY=$(fetch_param "${NACOS_IDENTITY_KEY_PARAM}")
NACOS_ID_VALUE=$(fetch_param "${NACOS_IDENTITY_VALUE_PARAM}")

# 如果没传，生成默认值（仅 HA 测试用，生产必须显式传 SSM Parameter）
if [ -z "${NACOS_TOKEN_KEY}" ]; then
    NACOS_TOKEN_KEY=$(openssl rand -base64 32)
    echo "WARNING: NACOS_TOKEN_SECRET_KEY_PARAM not set, using ephemeral key (NOT for production)"
fi
[ -z "${NACOS_ID_KEY}" ] && NACOS_ID_KEY=$(openssl rand -hex 16)
[ -z "${NACOS_ID_VALUE}" ] && NACOS_ID_VALUE=$(openssl rand -hex 16)

# === 4. 写 application.properties ===
cat > /opt/nacos/conf/application.properties <<EOF
#=========== Datasource ============
spring.sql.init.platform=mysql
db.num=1
# 不加 autoReconnect / connectionTestQuery（详见部署文档 §5.5 v1.17 修订）
db.url.0=jdbc:mysql://${AURORA_ENDPOINT}:3306/${AURORA_DB_NAME}?characterEncoding=utf8&connectTimeout=1000&socketTimeout=3000&useUnicode=true&useSSL=false&serverTimezone=UTC
db.user=${AURORA_USER}
db.password=${DB_PASSWORD}

#=========== Aurora failover 关键配置（实测 RTO ≈ 1 分钟）============
db.pool.config.maxLifetime=60000
db.pool.config.idleTimeout=30000
db.pool.config.keepaliveTime=20000
db.pool.config.validationTimeout=3000
db.pool.config.connectionTimeout=5000

#=========== 鉴权 ============
nacos.core.auth.enabled=true
nacos.core.auth.console.enabled=true
nacos.core.auth.system.type=nacos
nacos.core.auth.plugin.nacos.token.expire.seconds=18000
nacos.core.auth.plugin.nacos.token.secret.key=${NACOS_TOKEN_KEY}
nacos.core.auth.server.identity.key=${NACOS_ID_KEY}
nacos.core.auth.server.identity.value=${NACOS_ID_VALUE}

#=========== 端口 ============
server.port=8848
nacos.console.port=8080

#=========== 集群成员发现：address-server 模式 ============
# 节点定期 GET http(s)://\${address.server.domain}:\${address.server.port}\${address.server.url}
# 拿其他节点 IP 列表（一行一个），由 Lambda 实时返回 ASG InService 实例 IP
nacos.core.member.lookup.type=address-server
address.server.domain=${ADDRESS_SERVER_DOMAIN}
address.server.port=${ADDRESS_SERVER_PORT}
address.server.url=${ADDRESS_SERVER_URL}

#=========== 日志 ============
nacos.logs.path=/opt/nacos/logs

#=========== Prometheus 监控 ============
management.endpoints.web.exposure.include=prometheus
nacos.prometheus.metrics.enabled=true
EOF

# === 5. 改 startup.sh：JVM 参数 ===
# 5.1 加 DNS TTL（Aurora failover 必备）
if ! grep -q "sun.net.inetaddr.ttl" /opt/nacos/bin/startup.sh; then
    sed -i '/^else$/,/^fi$/ { /-server.*Xms.*Xmx/ a\
    JAVA_OPT="${JAVA_OPT} -Dsun.net.inetaddr.ttl=5 -Dsun.net.inetaddr.negative.ttl=0"
}' /opt/nacos/bin/startup.sh
fi

# 5.2 改 Xmx（实例 16G → 给 Nacos 8G；如果实例小，按比例调）
TOTAL_MEM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "${TOTAL_MEM_MB}" -ge 14000 ]; then
    HEAP="-Xms8g -Xmx8g -Xmn4g"
elif [ "${TOTAL_MEM_MB}" -ge 7000 ]; then
    HEAP="-Xms4g -Xmx4g -Xmn2g"
else
    HEAP="-Xms2g -Xmx2g -Xmn1g"
fi
# 通过 CUSTOM_NACOS_MEMORY 环境变量传给 startup.sh（startup.sh 已经支持这个变量）
echo "CUSTOM_NACOS_MEMORY=\"${HEAP}\"" > /etc/sysconfig/nacos

# === 6. owner ===
chown -R nacos:nacos /opt/nacos

# === 7. systemd 服务 ===
cat > /etc/systemd/system/nacos.service <<'EOF'
[Unit]
Description=Nacos Server
After=network.target

[Service]
Type=forking
User=nacos
Group=nacos
EnvironmentFile=-/etc/sysconfig/nacos
Environment="JAVA_HOME=/usr/lib/jvm/java-17-amazon-corretto"
# 兜底：每次启动前修正 owner，防止人为 sudo 操作把日志/配置弄成 root 拥有
ExecStartPre=/bin/chown -R nacos:nacos /opt/nacos
ExecStart=/opt/nacos/bin/startup.sh
ExecStop=/opt/nacos/bin/shutdown.sh
Restart=on-failure
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable nacos
systemctl start nacos

# === 8. 健康检查（最多等 3 分钟）===
echo "=== Waiting Nacos to become ready ==="
for i in $(seq 1 36); do
    if curl -sf "http://localhost:8080/v3/console/health/readiness" > /dev/null 2>&1; then
        echo "=== Nacos ready after ${i}*5s ==="
        break
    fi
    sleep 5
done

# === 9. ADOT Sidecar (可选，仅当传了 AMP_REMOTE_WRITE_URL) ===
if [ -n "${AMP_REMOTE_WRITE_URL}" ]; then
    echo "=== Installing ADOT Collector for AMP ==="
    # 装 ADOT
    rpm -Uvh https://aws-otel-collector.s3.amazonaws.com/amazon_linux/amd64/latest/aws-otel-collector.rpm || true

    # 装 node_exporter（绑 localhost）
    cd /tmp
    NODE_EXPORTER_VER=1.7.0
    wget -q "https://github.com/prometheus/node_exporter/releases/download/v${NODE_EXPORTER_VER}/node_exporter-${NODE_EXPORTER_VER}.linux-amd64.tar.gz"
    tar -xzf "node_exporter-${NODE_EXPORTER_VER}.linux-amd64.tar.gz"
    install -m 755 "node_exporter-${NODE_EXPORTER_VER}.linux-amd64/node_exporter" /usr/local/bin/node_exporter

    cat > /etc/systemd/system/node_exporter.service <<'EOF'
[Unit]
Description=Node Exporter
After=network.target

[Service]
ExecStart=/usr/local/bin/node_exporter --web.listen-address=127.0.0.1:9100
Restart=on-failure

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable --now node_exporter

    # 拿实例元数据
    TOKEN=$(curl -sX PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 600")
    INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/instance-id)
    AZ=$(curl -s -H "X-aws-ec2-metadata-token: ${TOKEN}" http://169.254.169.254/latest/meta-data/placement/availability-zone)

    cat > /opt/aws/aws-otel-collector/etc/config.yaml <<EOF
extensions:
  sigv4auth:
    region: ${AWS_REGION_NAME}
    service: aps

receivers:
  prometheus:
    config:
      global:
        scrape_interval: 30s
        scrape_timeout: 10s
        external_labels:
          cluster: nacos-prod
          region: ${AWS_REGION_NAME}
          instance_id: ${INSTANCE_ID}
          az: ${AZ}
      scrape_configs:
        - job_name: nacos
          metrics_path: /nacos/actuator/prometheus
          static_configs:
            - targets: ['127.0.0.1:8848']
        - job_name: node
          static_configs:
            - targets: ['127.0.0.1:9100']

processors:
  memory_limiter:
    check_interval: 5s
    limit_percentage: 75
    spike_limit_percentage: 25
  batch:
    send_batch_size: 1000
    timeout: 10s

exporters:
  prometheusremotewrite:
    endpoint: ${AMP_REMOTE_WRITE_URL}
    auth:
      authenticator: sigv4auth
    timeout: 30s
    remote_write_queue:
      enabled: true
      queue_size: 10000
      num_consumers: 5
    retry_on_failure:
      enabled: true
      initial_interval: 5s
      max_interval: 30s
      max_elapsed_time: 5m

service:
  extensions: [sigv4auth]
  pipelines:
    metrics:
      receivers: [prometheus]
      processors: [memory_limiter, batch]
      exporters: [prometheusremotewrite]
  telemetry:
    metrics:
      address: 127.0.0.1:8888
EOF

    mkdir -p /etc/systemd/system/aws-otel-collector.service.d
    cat > /etc/systemd/system/aws-otel-collector.service.d/override.conf <<'EOF'
[Service]
MemoryLimit=512M
CPUQuota=50%
Restart=on-failure
RestartSec=10s
StartLimitIntervalSec=5min
StartLimitBurst=5
TimeoutStopSec=30s
EOF

    systemctl daemon-reload
    systemctl enable --now aws-otel-collector
    echo "=== ADOT installed ==="
fi

echo "=== Nacos bootstrap complete: $(date) ==="
