[**@victusfate/ricochet v1.10.0**](../README.md)

***

[@victusfate/ricochet](../globals.md) / isValidEvent

# Function: isValidEvent()

> **isValidEvent**(`e`): `e is InteractionEvent`

Defined in: [validation.ts:23](https://github.com/victusfate/ricochet/blob/main/src/validation.ts#L23)

Type guard — returns `true` when `e` is a structurally valid `InteractionEvent`.

Use this to filter untrusted arrays before passing them to `mfLearnOne` or
sending them to `POST /interactions`.

Validates: non-empty `userId`/`articleId`/`sourceId` within length limits,
1–10 taxonomy topics, a recognised `action`, and a positive finite `ts`.
Off-taxonomy topics are rejected — fabricated topics would otherwise pollute
the diversity-bucketed cold-start candidate pool.

## Parameters

### e

`unknown`

## Returns

`e is InteractionEvent`
