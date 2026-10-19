FROM node@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq mariadb-client php-cli python3 ripgrep \
    && rm -rf /var/lib/apt/lists/*

# The Harness mounts its runner at /opt/claude-support/runner.mjs; Node finds the SDK in /opt/node_modules.
RUN npm install --prefix /opt --no-audit --no-fund @anthropic-ai/claude-agent-sdk@0.3.296
RUN npm install --global --no-audit --no-fund @anthropic-ai/claude-code@2.1.296
