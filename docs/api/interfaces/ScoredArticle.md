[**@victusfate/ricochet v1.5.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / ScoredArticle

# Interface: ScoredArticle

Defined in: [types.ts:39](https://github.com/victusfate/ricochet/blob/41a11804dcf5b48c34e93617ead84c9de6a9679d/src/types.ts#L39)

Response from GET /recommendations/:userId.
Backward-compatible contract:
- articleIds + generatedAt remain stable for existing consumers.
- scoredArticleIds + diagnostics provide optional observability into CF ranking.

## Properties

### articleId

> **articleId**: `string`

Defined in: [types.ts:40](https://github.com/victusfate/ricochet/blob/41a11804dcf5b48c34e93617ead84c9de6a9679d/src/types.ts#L40)

***

### score

> **score**: `number`

Defined in: [types.ts:41](https://github.com/victusfate/ricochet/blob/41a11804dcf5b48c34e93617ead84c9de6a9679d/src/types.ts#L41)
