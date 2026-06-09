[**@victusfate/ricochet v1.7.1**](../README.md)

***

[@victusfate/ricochet](../globals.md) / isValidEvent

# Function: isValidEvent()

> **isValidEvent**(`e`): `e is InteractionEvent`

Defined in: [validation.ts:19](https://github.com/victusfate/ricochet/blob/05e1024558aa1ca4731aa49eeb4d4c7706ca9bcb/src/validation.ts#L19)

Type guard — returns `true` when `e` is a structurally valid `InteractionEvent`.

Use this to filter untrusted arrays before passing them to `mfLearnOne` or
sending them to `POST /interactions`.

Validates: non-empty `userId`/`articleId`/`sourceId` within length limits,
1–10 non-empty topic strings, a recognised `action`, and a positive finite `ts`.

## Parameters

### e

`unknown`

## Returns

`e is InteractionEvent`
