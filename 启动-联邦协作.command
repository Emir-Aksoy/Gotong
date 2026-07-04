#!/bin/zsh
# 双击启动 Gotong 联邦协作 demo
# 同机起两套 hub：
#   - 上游"大队伍" hub  :3200 web / :4200 ws  (.gotong-upstream/)
#   - 本地"小团队"  hub  :3300 web            (.gotong-team/)
# 本地团队通过一个 TeamBridgeAgent 作为单个 agent 接入上游。
#
# 第一次跑会自动 pnpm install + pnpm build。Ctrl-C 停止。

cd "$(dirname "$0")"

# 让 Finder 双击启动的窗口也能找到 nvm / node / pnpm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="/opt/homebrew/opt/curl/bin:/opt/homebrew/bin:$PATH"

echo "============================================"
echo "  Gotong 联邦协作 demo — 启动中"
echo "============================================"
echo "项目目录：$(pwd)"
echo "Node    ：$(node -v 2>/dev/null || echo '未找到')"
echo "pnpm    ：$(pnpm -v 2>/dev/null || echo '未找到')"
echo ""

if ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
  echo "❌ 找不到 node 或 pnpm。先在终端：nvm use 20 && npm i -g pnpm"
  read -k1 "?按任意键关闭…"
  exit 1
fi

# 首次启动：装依赖 + 编译
if [ ! -d node_modules ] || [ ! -d packages/core/dist ] || [ ! -d packages/sdk-node/dist ]; then
  echo "首次启动 — 安装依赖 + 编译，请稍等…"
  pnpm install || { echo "❌ pnpm install 失败"; read -k1 "?按任意键关闭…"; exit 1; }
  pnpm build   || { echo "❌ pnpm build 失败";   read -k1 "?按任意键关闭…"; exit 1; }
fi

echo ""
echo "============================================"
echo "  启动后浏览器打开（同一台 Mac）："
echo "    上游 admin :  http://localhost:3200/admin?token=<…>  (上游首次 token)"
echo "    本地 cockpit: http://localhost:3300/admin?token=<…>  (本地首次 token)"
echo "  Driver 会自动批准 bridge 并跑 3 个任务，看终端输出。"
echo "  Ctrl-C 停止全部进程。"
echo "============================================"
echo ""

pnpm demo:federated-team

echo ""
echo "进程已退出。"
read -k1 "?按任意键关闭窗口…"
