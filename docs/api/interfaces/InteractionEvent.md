[**@victusfate/ricochet v1.4.2**](../README.md)

***

[@victusfate/ricochet](../globals.md) / InteractionEvent

# Interface: InteractionEvent

Defined in: types.ts:21

A single user–article interaction event sent to POST /interactions.
userId is an anonymous stable identifier (e.g. SHA-256 of IndexedDB deviceId).
articleId is the 16-hex SHA-256(url)[:8] ID from boomerang rss-worker.

## Properties

### action

> **action**: [`Action`](../type-aliases/Action.md)

Defined in: types.ts:26

***

### articleId

> **articleId**: `string`

Defined in: types.ts:23

***

### sourceId

> **sourceId**: `string`

Defined in: types.ts:24

***

### topics

> **topics**: [`Topic`](../type-aliases/Topic.md)[]

Defined in: types.ts:25

***

### ts

> **ts**: `number`

Defined in: types.ts:27

***

### userId

> **userId**: `string`

Defined in: types.ts:22
