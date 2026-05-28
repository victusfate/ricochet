## [1.4.2](https://github.com/victusfate/ricochet/compare/v1.4.1...v1.4.2) (2026-05-28)

### Bug Fixes

* patch 9 code-review findings across parsing, DO, and Worker layers ([2cba724](https://github.com/victusfate/ricochet/commit/2cba7245bd7ce45e376e4c85dfac56af844e627d))

## [1.4.1](https://github.com/victusfate/ricochet/compare/v1.4.0...v1.4.1) (2026-05-28)

### Bug Fixes

* add src/parsing.ts to package files list ([e8c9f5d](https://github.com/victusfate/ricochet/commit/e8c9f5d0b2c17c0f6f852c58dbba6f5d6d5c5662))

## [1.4.0](https://github.com/victusfate/ricochet/compare/v1.3.1...v1.4.0) (2026-05-28)

### Features

* POST /recommendations with topicWeights, ETag caching, and new tests ([21bd71f](https://github.com/victusfate/ricochet/commit/21bd71f159574d0f83f9e503fcf4805d5e29d89e))
* ts index, cold-start diversity, topic-affinity, soft prune, DRY parsing ([e63624f](https://github.com/victusfate/ricochet/commit/e63624f96308629c51557ef6eca2c457ed9a4417))

### Bug Fixes

* **security:** harden input validation, rate limit, and timestamp handling ([4fe5982](https://github.com/victusfate/ricochet/commit/4fe59825085e7bdad96ec000b364d71761fe9db3))

## [1.3.1](https://github.com/victusfate/ricochet/compare/v1.3.0...v1.3.1) (2026-05-18)

### Bug Fixes

* export RankingCacheEntry, cache TTLs, and all types from public API ([6668bcc](https://github.com/victusfate/ricochet/commit/6668bcc3a4b855d6bee87c2e59aafcfe58d03432))

## [1.3.0](https://github.com/victusfate/ricochet/compare/v1.2.3...v1.3.0) (2026-05-17)

### Features

* export REC_FEED_POOL_CACHE_TTL_MS, REC_GLOBAL_CACHE_TTL_MS, RankingCacheEntry from lib ([01147ec](https://github.com/victusfate/ricochet/commit/01147ec54aa9357651aa51ad0ae1b1910e74a3cc))

## [1.2.3](https://github.com/victusfate/ricochet/compare/v1.2.2...v1.2.3) (2026-05-17)

### Bug Fixes

* protected state/env in RecDO + export RankingCacheEntry and cache TTLs ([dad8218](https://github.com/victusfate/ricochet/commit/dad821857b43a811ef03c42a0defc240634c2429))

## [1.2.2](https://github.com/victusfate/ricochet/compare/v1.2.1...v1.2.2) (2026-05-15)

### Bug Fixes

* expose recommendation candidate cap as shared constant ([10fcea9](https://github.com/victusfate/ricochet/commit/10fcea9244316a873da26111a99a39002702c14f))

## [1.2.1](https://github.com/victusfate/ricochet/compare/v1.2.0...v1.2.1) (2026-05-15)

### Bug Fixes

* enforce 100-candidate cap for feed-pool ranking ([156cade](https://github.com/victusfate/ricochet/commit/156cadeeb0252ad3a7ef9ac0a8d963f2509c8b77))

## [1.2.0](https://github.com/victusfate/ricochet/compare/v1.1.0...v1.2.0) (2026-05-15)

### Features

* support feed-pool candidate ranking for recommendations ([b55f61d](https://github.com/victusfate/ricochet/commit/b55f61dbddfe44acec98fe1c2b2a741448f99281))

## [1.1.0](https://github.com/victusfate/ricochet/compare/v1.0.0...v1.1.0) (2026-05-15)

### Features

* trigger release for observability contract ([5b30a17](https://github.com/victusfate/ricochet/commit/5b30a176a03174b9f3e8b7d63e117c5da6f31959))

## 1.0.0 (2026-05-08)

### Features

* **biased-mf-recs:** S1+S2 — pure BiasedMF math and SQLite schema ([0cb629f](https://github.com/victusfate/ricochet/commit/0cb629f47805923b3e96cf17e99b758564a114fe))
* **biased-mf-recs:** S3+S4 — learnOne, score, getTopCandidates ([6e465cc](https://github.com/victusfate/ricochet/commit/6e465cc0eec01ac4dd2f3883aa0f1514f9daf68c))
* **biased-mf-recs:** S5 — KV cache for /recommendations/:userId ([7355483](https://github.com/victusfate/ricochet/commit/73554835ef1d5c38edf1141a55bd01c645edebcb))
* configure package for npm publishing as @victusfate/ricochet ([f82782f](https://github.com/victusfate/ricochet/commit/f82782f1c7d97535acf71626b928b42189ef8e98))
* **edge-recommendations:** implement rec-worker with types, RecDO, routing, tests, docs ([c0963be](https://github.com/victusfate/ricochet/commit/c0963be860e72a51450d9e91cda32761f04dba74))
* **eval:** offline BiasedMF evaluation on synthetic rating dataset ([2bb1ef3](https://github.com/victusfate/ricochet/commit/2bb1ef350df79b540488fa30f1d6d61565070f03))
* **eval:** support real MovieLens 100K dataset ([6c5994b](https://github.com/victusfate/ricochet/commit/6c5994b78d445d6ca7d49f55ba525b736c2bc38e))
* expose worker subpath export for boomerang rec-worker ([b6a9b11](https://github.com/victusfate/ricochet/commit/b6a9b1140b574eeda2c85fc11b891cb03fc79b6c))

### Bug Fixes

* add prepare script so GitHub installs auto-build dist/ ([4ef2558](https://github.com/victusfate/ricochet/commit/4ef2558ff60bc00323c145e8c60d66c876272155))
* boost item bias with seed users to stabilize S2 dedup ordering test ([e6ef756](https://github.com/victusfate/ricochet/commit/e6ef7562590399f93591cfa6e1130cbf593f919b))
* **ci:** use node 22 for semantic-release ([9d2354e](https://github.com/victusfate/ricochet/commit/9d2354efb1e824b125134bedf906ad1e07e0d665))
* trigger patch release ([0c754e2](https://github.com/victusfate/ricochet/commit/0c754e223d258c03a014de2bafea00714cbdfcdc))
