# secretary

A [Spectrum](https://photon.codes/docs/spectrum-ts) project. Wired with: imessage.

## Environment

Before running, open `.env` and fill in the values:

From your project Settings on the [Photon dashboard](https://app.photon.codes):

- `PROJECT_ID`
- `PROJECT_SECRET`

## Run

```sh
bun install
bun test
bun dev
```

`bun dev` connects to iMessage, opens the Google OAuth callback on `PUBLIC_BASE_URL`, and answers when a group is picking a time. Ordinary messages get no reply. Poll votes book the option with the most votes after everyone who spoke has voted, or three minutes after the last vote.

## Where to go next

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- Add the agent to a group chat, then text a plan such as "anyone available to hop on overwatch".
