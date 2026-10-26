/**
 * The Lab scenarios removed in #353 (ADR 0026, 2026-10-26 addendum), kept as
 * data only so past `lab-provisioned.scenario` records still read: the pinned
 * digest and the plugin each scenario was bound to. No Lab is built from them;
 * the setup scripts live under the `archive/pre-353-deletion` tag.
 */
const RETIRED_WORDPRESS_SCENARIOS: Readonly<
  Record<
    string,
    { readonly digest: string; readonly pluginSlug: string | null }
  >
> = {
  "approved-comment-v1": {
    digest:
      "sha256:a9c59e0011d96d800a5b44657f6d608eb914af00c6d2a16bad85dfc31d960ebe",
    pluginSlug: null,
  },
  "approved-comment-searchable-v1": {
    digest:
      "sha256:9d3da1e037c7b986f9b6ae3b6300bda900af1ccd330e355936d094643490a3c6",
    pluginSlug: null,
  },
  "public-booking-page-v1": {
    digest:
      "sha256:2eee266e20d5f3fd97691d3fca7e6a6b29c31c27bca89f24e91a270c3c9b2a19",
    pluginSlug: null,
  },
  "public-builder-page-v1": {
    digest:
      "sha256:eb3935f5d09cbce5598408d9f9e01ec167e11f9ad7153d06a6987edf237d81a7",
    pluginSlug: null,
  },
  "public-file-attachment-form-v1": {
    digest:
      "sha256:74e511ab2d7f35e0249cd42efcb82bfc9f4bf569820435742db3b3ad80a5dc58",
    pluginSlug: null,
  },
  "translatepress-translation-data-v1": {
    digest:
      "sha256:111ae6445c8290ae49494ebf4ae116994262722f74114994ed4115ad5930bffc",
    pluginSlug: "translatepress-multilingual",
  },
  "private-post-v1": {
    digest:
      "sha256:2bcd33b635494333e9337af9a0a08e5336bb82d6be7098f59ba044d4b98ccb26",
    pluginSlug: null,
  },
  "private-page-v1": {
    digest:
      "sha256:8699068b8ba01eec99b5675b63d6c27d5ab612118ed4248df38998457e27d147",
    pluginSlug: null,
  },
  "public-registration-and-account-v1": {
    digest:
      "sha256:95cf63ae1968865ee518478ed35064811bb70698a7f4e9decf7b5adba9bc4477",
    pluginSlug: "user-registration",
  },
  "public-free-membership-v1": {
    digest:
      "sha256:f40f50bb92dba2d4cf1a67bd91481134ba6b420a7a9fc677d9bf3f7b56e3c06b",
    pluginSlug: "user-registration",
  },
  "public-free-membership-v2": {
    digest:
      "sha256:1166ed5494a84ba73d430c0b7f8a71d0a34742d71279f0b5fca237c97ec00423",
    pluginSlug: "user-registration",
  },
  "public-plugin-comment-v1": {
    digest:
      "sha256:5051e8b9acb5c18b6c3b5428e8489fb764d158376b21f3ddebebb287cf22bb8c",
    pluginSlug: "wpdiscuz",
  },
  "public-member-post-v1": {
    digest:
      "sha256:514d484423cd823054545d984b4ab3bbb8b6475575df3fc6eeb6109d13846af6",
    pluginSlug: "wp-members",
  },
};

/** A past Lab's scenario record, read against its pin; never used to build a Lab. */
export function retiredWordPressScenario(
  id: string,
): { readonly digest: string; readonly pluginSlug: string | null } | undefined {
  return Object.hasOwn(RETIRED_WORDPRESS_SCENARIOS, id)
    ? RETIRED_WORDPRESS_SCENARIOS[id]
    : undefined;
}
