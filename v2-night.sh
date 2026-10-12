#!/bin/bash
cd E:/BaiduMap
# 精确等待到次日 00:05（百度配额日重置 + 缓冲）
target=$(date -d "tomorrow 00:05" +%s)
now=$(date +%s)
wait_s=$((target - now))
echo "waiting ${wait_s}s until 00:05..."
sleep $wait_s
echo "quota reset, starting measurement at $(date +%H:%M)..."
npm run build 2>&1 | tail -1
npm run build:server 2>&1 | tail -1
PID=$(netstat -ano | grep ':8807' | grep LISTEN | head -1 | awk '{print $NF}')
[ -n "$PID" ] && taskkill //F //PID $PID 2>/dev/null
HTTP_PROXY= HTTPS_PROXY= NODE_ENV=production PORT=8807 BAIDU_MAP_AK_SERVER=rVDX1ZTOGLlzOiiJTfLsKVSY3K45eTcR BAIDU_MAP_AK_BROWSER=Y0bGWYbBnA4haLuKE05aKudJKZV0dW9a node dist-server/index.cjs > server-main.log 2>&1 &
sleep 5
node v2-measure.mjs
