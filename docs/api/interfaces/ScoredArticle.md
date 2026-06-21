[**@victusfate/ricochet v2.1.2**](../README.md)

***

[@victusfate/ricochet](../globals.md) / ScoredArticle

# Interface: ScoredArticle

Defined in: [types.ts:60](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L60)

Response from GET /recommendations/:userId.
Backward-compatible contract:
- articleIds + generatedAt remain stable for existing consumers.
- scoredArticleIds + diagnostics provide optional observability into CF ranking.

## Properties

### articleId

> **articleId**: `string`

Defined in: [types.ts:61](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L61)

***

### score

> **score**: `number`

Defined in: [types.ts:62](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L62)
