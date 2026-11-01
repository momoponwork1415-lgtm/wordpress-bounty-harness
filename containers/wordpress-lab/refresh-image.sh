#!/usr/bin/env bash
# Follows the latest stable WordPress release for the Lab image (#741, ADR 0047).
#
#   ./refresh-image.sh [--version <x.y.z>] [--php 8.3] [--write <host.json>]
#
# Reads the latest stable version from WordPress.org's version check (or takes
# --version), pulls the official wordpress:<version>-php<php>-apache image,
# and prints the digest-pinned reference for `images.wordpress` and the
# `WORDPRESS_BASE` build argument. --write sets images.wordpress in the named
# Git-external host config. Nothing else is changed; restart the runner after.
set -euo pipefail

version=""
php="8.3"
write=""
while [ $# -gt 0 ]; do
  case "$1" in
    --version) version="$2"; shift 2 ;;
    --php) php="$2"; shift 2 ;;
    --write) write="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$version" ]; then
  version="$(curl -fsS --max-time 30 'https://api.wordpress.org/core/version-check/1.7/' \
    | node -e 'let b="";process.stdin.on("data",c=>b+=c).on("end",()=>{const v=JSON.parse(b).offers[0].current;if(!/^[0-9]+(\.[0-9]+){1,3}$/.test(v))process.exit(1);console.log(v);})')"
fi
case "$version" in
  *[!0-9.]*|"") echo "invalid version: $version" >&2; exit 2 ;;
esac

tag="wordpress:${version}-php${php}-apache"
echo "pulling ${tag}" >&2
docker pull --quiet "$tag" >/dev/null
digest="$(docker image inspect "$tag" --format '{{index .RepoDigests 0}}')"
case "$digest" in
  wordpress@sha256:*) ;;
  *) echo "unexpected RepoDigest: $digest" >&2; exit 1 ;;
esac
shipped="$(docker run --rm --runtime=runsc --network=none --read-only --cap-drop=ALL \
  --security-opt=no-new-privileges --entrypoint=php "$digest" \
  -r 'preg_match("/\$wp_version\s*=\s*\x27([0-9A-Za-z.-]{1,32})\x27/", file_get_contents("/usr/src/wordpress/wp-includes/version.php"), $m); echo $m[1];')"
if [ "$shipped" != "$version" ]; then
  echo "the image ships WordPress ${shipped}, not ${version}" >&2
  exit 1
fi

echo "wordpress ${version}"
echo "images.wordpress: ${digest}"
echo "WORDPRESS_BASE=${tag}@${digest#wordpress@}"

if [ -n "$write" ]; then
  node -e '
    const fs=require("fs");const [path,digest]=process.argv.slice(1);
    const host=JSON.parse(fs.readFileSync(path,"utf8"));
    host.images.wordpress=digest;
    fs.writeFileSync(path,JSON.stringify(host,null,2)+"\n");
  ' "$write" "$digest"
  echo "wrote images.wordpress to ${write}"
fi
