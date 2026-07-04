#!/bin/zsh
# 双击清空 Open Space 工作区，下一次启动会重新生成新的 admin token
# 不影响代码 / 依赖 / 其他 demo

cd "$(dirname "$0")"

TARGET="examples/open-space/.gotong-open-space"

echo "============================================"
echo "  Gotong Open Space — 重置工作区"
echo "============================================"
echo ""
echo "将删除：$(pwd)/$TARGET"
echo ""

if [ ! -d "$TARGET" ]; then
  echo "目录不存在，无需重置。"
  echo ""
  read -k1 "?按任意键关闭…"
  exit 0
fi

echo "确定删除？(y/N) "
read -k1 ans
echo ""
if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
  rm -rf "$TARGET"
  echo "✅ 已删除。下次双击 \"启动-OpenSpace.command\" 会生成新的 admin token。"
else
  echo "已取消。"
fi

echo ""
read -k1 "?按任意键关闭…"
