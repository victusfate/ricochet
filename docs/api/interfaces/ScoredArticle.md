[**@victusfate/ricochet v1.6.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / ScoredArticle

# Interface: ScoredArticle

Defined in: [types.ts:39](https://github.com/victusfate/ricochet/blob/6529db6ce6df22d258291217fe235fa0e8623954/src/types.ts#L39)

Response from GET /recommendations/:userId.
Backward-compatible contract:
- articleIds + generatedAt remain stable for existing consumers.
- scoredArticleIds + diagnostics provide optional observability into CF ranking.

## Properties

### articleId

> **articleId**: `string`

Defined in: [types.ts:40](https://github.com/victusfate/ricochet/blob/6529db6ce6df22d258291217fe235fa0e8623954/src/types.ts#L40)

***

### score

> **score**: `number`

Defined in: [types.ts:41](https://github.com/victusfate/ricochet/blob/6529db6ce6df22d258291217fe235fa0e8623954/src/types.ts#L41)
