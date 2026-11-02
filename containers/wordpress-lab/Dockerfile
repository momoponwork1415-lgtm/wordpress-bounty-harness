# The Lab's WordPress image: the pinned official base plus pdo_mysql and
# Xdebug in trace mode (ADR 0049, #793). Xdebug starts only for a request that
# carries the trigger value, which the Harness sets per Lab through the
# WBH_XDEBUG_TRIGGER environment variable at container start and never writes
# anywhere an agent reads; the Harness sends it as a cookie on the one request
# `POST /trace` asks for. Without the variable the trigger value is empty and
# Xdebug would accept any trigger, so the Harness always sets it.
#
# Changing this file changes the built image's digest: the operator rebuilds,
# pushes and re-pins `images.wordpress` in the Git-external host config
# (README.md in this directory). `pecl install` downloads the pinned release,
# so the build needs network access for that step.
ARG WORDPRESS_BASE=wordpress:7.1.3-php8.3-apache@sha256:8ecd8d8e374167ea22235acf30f80d1165b82f07ffa5bcef90c1cad8f7be251f
FROM ${WORDPRESS_BASE}

RUN docker-php-ext-install -j1 pdo_mysql

# Xdebug 3.4.7 (released 2025-10-26). The ini runs trace mode on trigger only,
# writes format 1 (tab-separated, one line per call) without parameters or
# return values, uncompressed, into a directory the Apache worker owns.
RUN pecl install xdebug-3.4.7 \
  && docker-php-ext-enable xdebug \
  && mkdir -p /var/tmp/wbh-trace \
  && chown www-data:www-data /var/tmp/wbh-trace \
  && chmod 0700 /var/tmp/wbh-trace \
  && printf '%s\n' \
    'xdebug.mode=trace' \
    'xdebug.start_with_request=trigger' \
    'xdebug.trigger_value=${WBH_XDEBUG_TRIGGER}' \
    'xdebug.output_dir=/var/tmp/wbh-trace' \
    'xdebug.trace_output_name=trace.%u' \
    'xdebug.trace_format=1' \
    'xdebug.use_compression=0' \
    'xdebug.collect_params=0' \
    'xdebug.collect_return=0' \
    'xdebug.var_display_max_depth=0' \
    > /usr/local/etc/php/conf.d/zz-wbh-xdebug.ini
