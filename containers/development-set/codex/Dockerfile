FROM node@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git jq mariadb-client php-cli python3 ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN npm install --global @openai/codex@0.161.0
