[**@victusfate/ricochet v1.4.2**](../README.md)

***

[@victusfate/ricochet](../globals.md) / ScoredArticle

# Interface: ScoredArticle

Defined in: types.ts:39

Response from GET /recommendations/:userId.
Backward-compatible contract:
- articleIds + generatedAt remain stable for existing consumers.
- scoredArticleIds + diagnostics provide optional observability into CF ranking.

## Properties

### articleId

> **articleId**: `string`

Defined in: types.ts:40

***

### score

> **score**: `number`

Defined in: types.ts:41
