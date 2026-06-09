[**@victusfate/ricochet v1.10.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / ScoredArticle

# Interface: ScoredArticle

Defined in: [types.ts:57](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L57)

Response from GET /recommendations/:userId.
Backward-compatible contract:
- articleIds + generatedAt remain stable for existing consumers.
- scoredArticleIds + diagnostics provide optional observability into CF ranking.

## Properties

### articleId

> **articleId**: `string`

Defined in: [types.ts:58](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L58)

***

### score

> **score**: `number`

Defined in: [types.ts:59](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L59)
