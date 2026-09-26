#!/usr/bin/env bash
# ============================================================
# deploy-test.sh — 测试环境手动部署脚本（wrangler 直传 Pages）
#
# 流程：生成部署包 → 创建 Pages 项目/KV（如缺）→ wrangler 部署
#       → 部署后 API 设置 KV 绑定与 APP_PASSWORD → 绑定自定义域名 → 校验 DNS
#
# 为什么部署后再设绑定：wrangler pages deploy 会用本地 wrangler.toml 同步
# 项目级绑定，因此必须在部署完成后用 API 一次性写回 KV 绑定与环境变量。
#
# 用法：
#   APP_PASSWORD=admin123 \
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

echo "==> 1/7 生成部署包"
node "${ROOT}/scripts/package.mjs" >/dev/null

echo "==> 2/7 检查/创建 Pages 项目 ${CF_PROJECT}"
PROJ_EXIST=$(curl -s "${AUTH[@]}" "${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}")
if echo "$PROJ_EXIST" | grep -q '"success":true'; then
  echo "    项目已存在"
else
  curl -s "${AUTH[@]}" -X POST "${API}/accounts/${CF_ACCOUNT}/pages/projects" \
    -d "{\"name\":\"${CF_PROJECT}\",\"production_branch\":\"main\"}" >/dev/null
  echo "    项目已创建"
fi

echo "==> 3/7 检查/创建 KV 命名空间"
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

echo "==> 4/7 生成部署期绑定配置并 wrangler 部署（手动直传部署包）"
# wrangler 部署时会按 CWD 的 wrangler.toml 同步项目级 KV 绑定，
# 因此生成带真实 KV id 的配置并从 dist 目录执行，部署即带上绑定。
cat > "${ROOT}/dist/wrangler.toml" <<EOF
name = "vpngate"
compatibility_date = "2025-09-01"
pages_build_output_dir = "."

[[kv_namespaces]]
binding = "VPNGATE_CFG"
id = "${KV_ID}"
EOF
export CLOUDFLARE_API_TOKEN="${CF_TOKEN}" CLOUDFLARE_ACCOUNT_ID="${CF_ACCOUNT}"
(
  cd "${ROOT}/dist" && npx -y wrangler@4 pages deploy . \
    --project-name "${CF_PROJECT}" --branch main --commit-dirty=true
) 2>&1 | grep -E "Deployment complete|pages.dev" || true

echo "==> 5/7 部署后设置 KV 绑定与 APP_PASSWORD（production + preview）"
ENV_JSON="{}"
if [ -n "${APP_PASSWORD:-}" ]; then
  ENV_JSON="{\"APP_PASSWORD\":{\"type\":\"secret_text\",\"value\":\"${APP_PASSWORD}\"}}"
fi
BODY=$(python3 - "${KV_ID}" "${ENV_JSON}" <<'PYEOF'
import json, sys
kv_id, env = sys.argv[1], json.loads(sys.argv[2])
body = {"deployment_configs": {"production": {}, "preview": {}}}
for stage in ("production", "preview"):
    body["deployment_configs"][stage]["kv_namespaces"] = {"VPNGATE_CFG": {"namespace_id": kv_id}}
    if env:
        body["deployment_configs"][stage]["env_vars"] = env
print(json.dumps(body))
PYEOF
)
curl -s "${AUTH[@]}" -X PATCH "${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}" \
  -d "${BODY}" >/dev/null
echo "    KV 绑定 + APP_PASSWORD 已写回（${APP_PASSWORD:+已配置密码}${APP_PASSWORD:-未配置密码}）"

echo "==> 6/7 绑定自定义域名 ${CF_DOMAIN}（如未绑定）"
DOM=$(curl -s "${AUTH[@]}" "${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}/domains/${CF_DOMAIN}")
if ! echo "$DOM" | grep -q '"success":true'; then
  BIND=$(curl -s "${AUTH[@]}" -X POST \
    "${API}/accounts/${CF_ACCOUNT}/pages/projects/${CF_PROJECT}/domains" \
    -d "{\"name\":\"${CF_DOMAIN}\"}")
  if echo "$BIND" | grep -q '"success":true'; then
    echo "    自定义域名已绑定（等待 DNS 生效）"
  else
    echo "    ⚠ 域名绑定失败：$(echo "$BIND" | python3 -c "import json,sys; d=json.load(sys.stdin); print('; '.join(e.get('message','') for e in d.get('errors',[])))" 2>/dev/null || echo '未知错误')"
  fi
fi

echo "==> 7/7 校验/补充 DNS CNAME（令牌无 DNS 权限则提示手动添加）"
ZONE_ID=$(curl -s "${AUTH[@]}" "${API}/zones?name=${CF_DOMAIN#*.}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['result'][0]['id'] if d.get('result') else '')")
SUB="${CF_DOMAIN%%.*}"
if [ -n "$ZONE_ID" ]; then
  REC=$(curl -s "${AUTH[@]}" "${API}/zones/${ZONE_ID}/dns_records?type=CNAME&name=${CF_DOMAIN}")
  if echo "$REC" | grep -q '"success":true' && echo "$REC" | grep -q "${CF_PROJECT}.pages.dev"; then
    echo "    DNS CNAME 已存在：${SUB} → ${CF_PROJECT}.pages.dev"
  else
    DNS_R=$(curl -s "${AUTH[@]}" -X POST "${API}/zones/${ZONE_ID}/dns_records" \
      -d "{\"type\":\"CNAME\",\"name\":\"${SUB}\",\"content\":\"${CF_PROJECT}.pages.dev\",\"proxied\":true}")
    if echo "$DNS_R" | grep -q '"success":true'; then
      echo "    DNS CNAME 已补充：${SUB} → ${CF_PROJECT}.pages.dev"
    else
      ERR=$(echo "$DNS_R" | python3 -c "import json,sys; d=json.load(sys.stdin); print('; '.join(e.get('message','') for e in d.get('errors',[])))" 2>/dev/null || echo '未知错误')
      echo "    ⚠ 自动添加 DNS 失败（${ERR}）"
      echo "    ⚠ 请手动在 CF 控制台为 ${CF_DOMAIN#*.} 添加：CNAME ${SUB} → ${CF_PROJECT}.pages.dev（开启代理）"
    fi
  fi
fi

echo ""
echo "============================================"
echo "部署完成：https://${CF_DOMAIN}（DNS 生效后可用）"
echo "pages.dev 临时地址见上方输出"
echo "============================================"
