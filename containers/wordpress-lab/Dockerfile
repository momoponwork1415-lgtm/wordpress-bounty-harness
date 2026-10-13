ARG WORDPRESS_BASE=wordpress:7.1.3-php8.3-apache@sha256:8ecd8d8e374167ea22235acf30f80d1165b82f07ffa5bcef90c1cad8f7be251f
FROM ${WORDPRESS_BASE}

RUN docker-php-ext-install -j1 pdo_mysql
