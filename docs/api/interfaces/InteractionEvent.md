[**@victusfate/ricochet v1.5.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / InteractionEvent

# Interface: InteractionEvent

Defined in: [types.ts:21](https://github.com/victusfate/ricochet/blob/41a11804dcf5b48c34e93617ead84c9de6a9679d/src/types.ts#L21)

A single user–article interaction event sent to POST /interactions.
userId is an anonymous stable identifier (e.g. SHA-256 of IndexedDB deviceId).
articleId is the 16-hex SHA-256(url)[:8] ID from boomerang rss-worker.

## Properties

### action

> **action**: [`Action`](../type-aliases/Action.md)

Defined in: [types.ts:26](https://github.com/victusfate/ricochet/blob/41a11804dcf5b48c34e93617ead84c9de6a9679d/src/types.ts#L26)

***

### articleId

> **articleId**: `string`

Defined in: [types.ts:23](https://github.com/victusfate/ricochet/blob/41a11804dcf5b48c34e93617ead84c9de6a9679d/src/types.ts#L23)

***

### sourceId

> **sourceId**: `string`

Defined in: [types.ts:24](https://github.com/victusfate/ricochet/blob/41a11804dcf5b48c34e93617ead84c9de6a9679d/src/types.ts#L24)

***

### topics

> **topics**: [`Topic`](../type-aliases/Topic.md)[]

Defined in: [types.ts:25](https://github.com/victusfate/ricochet/blob/41a11804dcf5b48c34e93617ead84c9de6a9679d/src/types.ts#L25)

***

### ts

> **ts**: `number`

Defined in: [types.ts:27](https://github.com/victusfate/ricochet/blob/41a11804dcf5b48c34e93617ead84c9de6a9679d/src/types.ts#L27)

***

### userId

> **userId**: `string`

Defined in: [types.ts:22](https://github.com/victusfate/ricochet/blob/41a11804dcf5b48c34e93617ead84c9de6a9679d/src/types.ts#L22)
