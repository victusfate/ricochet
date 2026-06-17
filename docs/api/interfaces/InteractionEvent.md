[**@victusfate/ricochet v2.0.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / InteractionEvent

# Interface: InteractionEvent

Defined in: [types.ts:25](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L25)

A single user–article interaction event sent to POST /interactions.
userId is an anonymous stable identifier (e.g. SHA-256 of IndexedDB deviceId).
articleId is the 16-hex SHA-256(url)[:8] ID from boomerang rss-worker.

## Properties

### action

> **action**: `"read"` \| `"upvote"` \| `"downvote"` \| `"save"` \| `"seen"`

Defined in: [types.ts:30](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L30)

***

### articleId

> **articleId**: `string`

Defined in: [types.ts:27](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L27)

***

### sourceId

> **sourceId**: `string`

Defined in: [types.ts:28](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L28)

***

### topics

> **topics**: (`"technology"` \| `"science"` \| `"world"` \| `"business"` \| `"health"` \| `"environment"` \| `"sports"` \| `"entertainment"` \| `"general"`)[]

Defined in: [types.ts:29](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L29)

***

### ts

> **ts**: `number`

Defined in: [types.ts:31](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L31)

***

### userId

> **userId**: `string`

Defined in: [types.ts:26](https://github.com/victusfate/ricochet/blob/main/src/types.ts#L26)
