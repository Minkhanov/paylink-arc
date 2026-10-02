PayLink - materials for the Circle Grants application (code: github.com/Minkhanov/paylink-arc, commit 097477a, identical to 562efac for these files).

codebase-walkthrough.mp4 - 73 s codebase walkthrough (1920x1080, H.264 + AAC, burned-in subtitles, synthetic narration, no real person's voice) showing where the code uses Arc and USDC.
transcript.txt - the narration of the video, word for word.
1-arc-config.png - web/config.js, lines 1-15: the Arc mainnet entry (lines 9-14, chain 5042), its RPC, and the deployed contract address (line 13).
2-usdc-native-paylink-sol.png - src/PayLink.sol, lines 69-111: pay() is payable (76-78), msg.value must equal amount (83), the USDC is forwarded to the merchant (110-111).
3-usdc-in-app-1.png - web/app.js, line 18: NATIVE_DECIMALS = 18, Arc's native decimals.
3-usdc-in-app-2.png - web/app.js, lines 73-83: conversion between 18-decimal native USDC and 6-decimal amounts.
3-usdc-in-app-3.png - web/app.js, lines 222-232: Arc is added to the wallet with USDC as its currency (line 228).
3-usdc-in-app-4.png - web/app.js, lines 392-400: the network fee shown in dollars and paid in USDC (lines 398-399).

Status: experimental, unaudited.
