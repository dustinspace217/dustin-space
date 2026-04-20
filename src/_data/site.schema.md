# site.json — Global Site Data

Available in every Eleventy template as `{{ site.fieldName }}`.

| Field              | Notes |
|--------------------|-------|
| title              | Site name — appears in `<title>` and OG tags |
| tagline            | Short descriptor shown under the hero logo |
| description        | Default meta description — overridden per page via front matter `description` |
| url                | Canonical base URL with no trailing slash — used for absolute OG image URLs and JSON-LD structured data |
| author             | Used in JSON-LD structured data and the footer copyright line |
| giscus.repo        | GitHub repo in "owner/name" format — must have Discussions enabled |
| giscus.repoId      | GitHub's internal repo ID (starts with R_) — get it from the Giscus configurator at giscus.app |
| giscus.category    | Discussion category name to use for comment threads |
| giscus.categoryId  | GitHub's internal category ID (starts with DIC_) — from the Giscus configurator |

## Giscus setup

The `repoId` and `categoryId` values are public by Giscus design — they are embedded
in every built page's HTML. To configure Giscus for a new repo:

1. Enable Discussions on the GitHub repo.
2. Go to [giscus.app](https://giscus.app) and enter the repo name.
3. Copy the `data-repo-id` and `data-category-id` values into this file.

If `giscus.repoId` is set to `"PLACEHOLDER_REPO_ID"`, the comments section in
`image.njk` detects this and renders a "not yet configured" message instead of
loading the Giscus script.
