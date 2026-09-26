#!/usr/bin/env bash
# ============================================================
# deploy-test.sh — 测试环境手动部署脚本（Cloudflare Pages 直传）
#
# 流程：生成部署包 → 创建 Pages 项目/KV（如缺）→ 绑定 KV →
#       上传部署包 → 绑定自定义域名 → 校验 DNS → 输出访问地址
#
# 用法：
#   CF_ACCOUNT=<账户ID> CF_TOKEN=<API令牌> \
#   CF_PROJECT=vpngate-test CF_DOMAIN=vpngate-test.zhangsen.kdns.fr \
#   ./scripts/deploy-test.sh
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CF_ACCOUNT="${CF_ACCOUNT:?需设置 CF_ACCOUNT}"
CF_TOKEN="${CF_TOKEN:?需设置 CF_TOKEN}"
CF_PROJECT="${CF_PROJECT:?需设置 CF_PROJECT}"
CF_DOMAIN="${CF_DOMAIN:?需设置 CF_DOMAIN}"

API="https://api.cloudflare.com/client/v4"
AUTH=(-H "Authorization: Bearer ${CF_TOKEN}" -H "Content-Type: application/json")

echo "==> 1/6 生成部署包"
node "${ROOT}/scripts/package.mjs" >/dev/null

echo "==> 2/6 检查/创建 Pages 项目 ${CF_PROJECT}"
PROJ_EXIST=$(curl -s "${AUTH[@]}" "${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}")
if echo "$PROJ_EXIST" | grep -q '"success":true'; then
  echo "    项目已存在"
else
  curl -s "${AUTH[@]}" -X POST "${API}/accounts/${CF_ACCOUNT}/pages/projects" \
    -d "{\"name\":\"${CF_PROJECT}\",\"production_branch\":\"main\"}" >/dev/null
  echo "    项目已创建"
fi

echo "==> 3/6 检查/创建 KV 命名空间"
KV_LIST=$(curl -s "${AUTH[@]}" "${API}/accounts/${CF_ACCOUNT}/storage/kv/namespaces")
KV_ID=$(echo "$KV_LIST" | python3 -c "
import json,sys
d=json.load(sys.stdin)
for r in d.get('result',[]):
    if r['title']=='vpngate-cfg':
        print(r['id']); break
")
if [ -z "$KV_ID" ]; then
  KV_ID=$(curl -s "${AUTH[@]}" -X POST "${API}/accounts/${CF_ACCOUNT}/storage/kv/namespaces" \
    -d '{"title":"vpngate-cfg"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['id'])")
  echo "    KV 已创建：${KV_ID}"
else
  echo "    KV 已存在：${KV_ID}"
fi

echo "==> 4/6 绑定 KV 与环境变量到 Pages 项目（production + preview）"
# APP_PASSWORD 作为 secret_text 环境变量注入（登录密码配置化；未提供则跳过认证配置）
ENV_JSON="{}"
if [ -n "${APP_PASSWORD:-}" ]; then
  ENV_JSON="{\"APP_PASSWORD\":{\"type\":\"secret_text\",\"value\":\"${APP_PASSWORD}\"}}"
fi
BODY=$(python3 - "${KV_ID}" "${ENV_JSON}" <<'PYEOF'
import json, sys
kv_id, env = sys.argv[1], json.loads(sys.argv[2])
body = {"deployment_configs": {"production": {}, "preview": {}}}
for stage in ("production", "preview"):
    body["deployment_configs"][stage]["kv_namespaces"] = [{"namespace_id": kv_id, "binding": "VPNGATE_CFG"}]
    if env:
        body["deployment_configs"][stage]["env_vars"] = env
print(json.dumps(body))
PYEOF
)
curl -s "${AUTH[@]}" -X PATCH "${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}" \
  -d "${BODY}" >/dev/null
echo "    KV 绑定完成${APP_PASSWORD:+ · APP_PASSWORD 已配置（secret）}${APP_PASSWORD:- · 未配置 APP_PASSWORD}"

echo "==> 5/6 上传部署包（手动直传，manifest 模式）"
DEPLOY_OUT=$(python3 "${ROOT}/scripts/upload-pages.py" "${CF_ACCOUNT}" "${CF_TOKEN}" "${CF_PROJECT}" "${ROOT}/dist")
echo "${DEPLOY_OUT}"
DEPLOY_URL=$(echo "${DEPLOY_OUT}" | grep '^url:' | cut -d' ' -f2-)

echo "==> 6/6 绑定自定义域名 ${CF_DOMAIN}（如未绑定）"
DOM=$(curl -s "${AUTH[@]}" "${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}/domains/${CF_DOMAIN}")
if ! echo "$DOM" | grep -q '"success":true'; then
  curl -s "${AUTH[@]}" -X PUT \
    "${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}/domains/${CF_DOMAIN}" >/dev/null
fi

# 校验/补充 DNS CNAME（域名托管在 CF 时）
ZONE_ID=$(curl -s "${AUTH[@]}" "${API}/zones?name=${CF_DOMAIN#*.}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')")
SUB="${CF_DOMAIN%%.*}"
if [ -n "$ZONE_ID" ]; then
  REC=$(curl -s "${AUTH[@]}" "${API}/zones/${ZONE_ID}/dns_records?type=CNAME&name=${CF_DOMAIN}")
  if ! echo "$REC" | grep -q '"success":true' || ! echo "$REC" | grep -q "${CF_PROJECT}.pages.dev"; then
    curl -s "${AUTH[@]}" -X POST "${API}/zones/${ZONE_ID}/dns_records" \
      -d "{\"type\":\"CNAME\",\"name\":\"${SUB}\",\"content\":\"${CF_PROJECT}.pages.dev\",\"proxied\":true}" >/dev/null
    echo "    DNS CNAME 已补充：${SUB} → ${CF_PROJECT}.pages.dev"
  fi
fi

echo ""
echo "============================================"
echo "部署完成：https://${CF_DOMAIN}"
echo "临时地址：${DEPLOY_URL}"
echo "============================================"
