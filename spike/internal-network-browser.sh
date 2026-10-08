#!/usr/bin/env bash
set -euo pipefail

# Benign probe only: no plugin source, credentials, container socket, or egress.
worker_image='wpbounty-worker-codex@sha256:376fb1363ce4c3050de5b6e296d912be88bf129c6101421c8ca5c0790903d69f'
browser_image='wordpress-harness/verification-browser@sha256:e397399ea24f8a1fa49eefba9469e7ca255fc81f6c4f81c1af2453468f953d75'
probe_name="wbh-spike-$$"
network_name="${probe_name}-net"
server_name="${probe_name}-lab"

cleanup() {
  docker rm --force "$server_name" >/dev/null 2>&1 || true
  docker network rm "$network_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

start_ms="$(date +%s%3N)"
docker network create --internal "$network_name" >/dev/null
docker run --detach --pull=never --runtime=runsc \
  --name "$server_name" --network "$network_name" --network-alias lab \
  --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs=/tmp:rw,nosuid,nodev,size=64m \
  --entrypoint=node "$worker_image" \
  -e 'require("http").createServer((request,response)=>{response.end("lab-ok")}).listen(8080,"0.0.0.0")' >/dev/null
lab_address="$(docker inspect --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$server_name")"

set +e
docker run --rm --pull=never --runtime=runsc \
  --network "$network_name" --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --tmpfs=/tmp:rw,nosuid,nodev,size=64m \
  --entrypoint=node "$worker_image" \
  -e 'fetch("http://lab:8080").then(()=>process.exit(0)).catch(error=>{console.error(error.cause?.code ?? error.message);process.exit(1)})'
alias_dns_status=$?
set -e
printf 'alias_dns_exit=%s\n' "$alias_dns_status"

docker run --rm --pull=never --runtime=runsc \
  --network "$network_name" --add-host="lab:$lab_address" --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --tmpfs=/tmp:rw,nosuid,nodev,size=64m \
  --entrypoint=node "$worker_image" \
  -e 'fetch("http://lab:8080").then(async response => { const body = await response.text(); if (body !== "lab-ok") process.exit(2); console.log(body) }).catch(error => { console.error(error); process.exit(1) })'
network_ms="$(( $(date +%s%3N) - start_ms ))"
printf 'network_elapsed_ms=%s\n' "$network_ms"

browser_start_ms="$(date +%s%3N)"
docker run --rm --pull=never --runtime=runsc \
  --network "$network_name" --add-host="lab:$lab_address" --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --tmpfs=/tmp:rw,nosuid,nodev,size=512m \
  --workdir=/harness --entrypoint=node "$browser_image" \
  -e 'const {chromium}=require("playwright"); (async()=>{const browser=await chromium.launch({headless:true}); const page=await browser.newPage(); await page.goto("http://lab:8080"); const body=await page.textContent("body"); if(body!=="lab-ok") process.exitCode=2; console.log(`browser_body=${body}`); await browser.close()})().catch(error=>{console.error(error.message);process.exitCode=1})'
browser_ms="$(( $(date +%s%3N) - browser_start_ms ))"
printf 'browser_elapsed_ms=%s\n' "$browser_ms"
