#!/bin/zsh
# 双击启动 AipeHub Open Space demo
# 第一次跑会自动 pnpm install + pnpm build（约 1-2 分钟）
# 之后秒启。Ctrl-C 停止。

cd "$(dirname "$0")"

# 让 Finder 双击启动的窗口也能找到 nvm / node / pnpm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="/opt/homebrew/opt/curl/bin:/opt/homebrew/bin:$PATH"

echo "============================================"
echo "  AipeHub Open Space — 启动中"
echo "============================================"
echo "项目目录：$(pwd)"
echo "Node    ：$(node -v 2>/dev/null || echo '未找到')"
echo "pnpm    ：$(pnpm -v 2>/dev/null || echo '未找到')"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 找不到 node。请先在终端 'nvm use 20'。"
  echo ""
  read -k1 "?按任意键关闭…"
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "❌ 找不到 pnpm。请先在终端 'npm i -g pnpm'。"
  echo ""
  read -k1 "?按任意键关闭…"
  exit 1
fi

# 首次启动：装依赖 + 编译
if [ ! -d node_modules ] || [ ! -d packages/core/dist ]; then
  echo "首次启动 — 安装依赖 + 编译，请稍等…"
  pnpm install || { echo "❌ pnpm install 失败"; read -k1 "?按任意键关闭…"; exit 1; }
  pnpm build   || { echo "❌ pnpm build 失败";   read -k1 "?按任意键关闭…"; exit 1; }
fi

echo ""
echo "============================================"
echo "  启动完成后，终端会打印两条 URL："
echo "    Admin  : http://localhost:3100/admin?token=…"
echo "    Worker : http://localhost:3100/"
echo "  Admin URL 只显示一次，立刻在浏览器里打开！"
echo "  Ctrl-C 停止。"
echo "============================================"
echo ""

pnpm demo:open-space

echo ""
echo "进程已退出。"
read -k1 "?按任意键关闭窗口…"
