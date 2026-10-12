# WordPress Lab image

The Lab's WordPress image includes `pdo_mysql` for ordinary plugin database
features. The base image is pinned in `Dockerfile`; the host-private config pins
the built image by registry digest. Keep the WordPress core version in the image
aligned with the selection policy.

To update the image:

1. Set the desired WordPress/PHP base digest in `Dockerfile` and make sure that
   exact image is present locally.
2. Build with `docker build --network=none -t <registry>/wbh-wordpress-lab:<version> containers/wordpress-lab`.
3. Run `docker run --rm --runtime=runsc --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges --entrypoint=php <tag> -r 'echo json_encode(["php"=>PHP_VERSION,"pdo"=>extension_loaded("pdo"),"pdo_mysql"=>extension_loaded("pdo_mysql"),"mysqli"=>extension_loaded("mysqli")]);'` and require `pdo_mysql=true`.
4. Push the tag to the selected registry and read its `RepoDigests` with
   `docker image inspect <tag> --format '{{json .RepoDigests}}'`. Set
   `images.wordpress` in the Git-external host config to the exact
   `<registry>/wbh-wordpress-lab@sha256:<digest>` reference. Leave
   `images.wordpressCli` on its independently pinned image.
5. Run `harness runtime check --config <campaign.json>` and an ordinary-use
   smoke in a disposable runsc Lab. Check `lab cleanup --remove` and confirm
   zero leftover containers, networks, and volumes before starting a campaign.

Never put the host config, Lab evidence, or credentials in Git.
