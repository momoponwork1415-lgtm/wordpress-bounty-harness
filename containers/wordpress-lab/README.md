# WordPress Lab image

The Lab's WordPress image includes `pdo_mysql` for ordinary plugin database
features and Xdebug in trace mode, started only by a per-Lab trigger value
the Harness passes as `WBH_XDEBUG_TRIGGER` at container start (`POST /trace`
of the exploration Lab, ADR 0049). The base image is pinned in `Dockerfile`;
the host-private config pins the built image by registry digest.

Every change to `Dockerfile` changes the built image's digest. Until the
operator rebuilds, pushes and re-pins `images.wordpress`, Labs run the old
image: `POST /trace` then answers `unavailable` and nothing else changes.

The core version the image ships is the version every Snapshot, exploration
sandbox and Lab uses (#741, ADR 0047). Selection reads the latest stable release
from WordPress.org's version check and freezes nothing while the image is
behind it (`core-image-outdated`); `runtime check` prints the same comparison
as the `wordpress-core` item. Only development and historical runs pin a
version with `wordpressVersion` in the selection policy or campaign config.

To follow a new WordPress release, run `./refresh-image.sh` in this directory.
It reads the latest stable version, pulls the matching official
`wordpress:<version>-php8.3-apache` image, and prints its digest as the
`images.wordpress` value and as the `WORDPRESS_BASE` line for a custom build.
With `--write <host.json>` it sets `images.wordpress` in that Git-external host
config. Restart the runner afterwards; selection resumes on the next batch.

To update a custom-built image by hand:

1. Set the desired WordPress/PHP base digest in `Dockerfile` and make sure that
   exact image is present locally. For a different core version, pass its
   pinned base with `--build-arg WORDPRESS_BASE=<image>@sha256:<digest>`.
2. Build with `docker build -t <registry>/wbh-wordpress-lab:<version> containers/wordpress-lab` (and the build arg when needed). The `pecl install xdebug-<version>` step downloads the pinned release from pecl.php.net, so this build needs network access; the result is still pinned by digest.
3. Run `docker run --rm --runtime=runsc --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges --entrypoint=php <tag> -r 'echo json_encode(["php"=>PHP_VERSION,"pdo"=>extension_loaded("pdo"),"pdo_mysql"=>extension_loaded("pdo_mysql"),"mysqli"=>extension_loaded("mysqli"),"xdebug"=>extension_loaded("xdebug"),"xdebug_mode"=>ini_get("xdebug.mode")]);'` and require `pdo_mysql=true`, `xdebug=true` and `xdebug_mode="trace"`.
4. Push the tag to the selected registry and read its `RepoDigests` with
   `docker image inspect <tag> --format '{{json .RepoDigests}}'`. Set
   `images.wordpress` in the Git-external host config to the exact
   `<registry>/wbh-wordpress-lab@sha256:<digest>` reference. Leave
   `images.wordpressCli` on its independently pinned image.
5. Run `harness runtime check --config <campaign.json>` and an ordinary-use
   smoke in a disposable runsc Lab. Check `lab cleanup --config <campaign.json> --remove` and confirm
   zero leftover containers, networks, and volumes before starting a campaign.

Never put the host config, Lab evidence, or credentials in Git.
