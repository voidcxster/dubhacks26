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

`bun dev` connects to iMessage and opens the Google OAuth callback on `PUBLIC_BASE_URL`. In a one-to-one chat it suggests a few open times from the person's calendar and the conversation, then books the time they pick. The booking message includes a Google Calendar link they can use if the event is not added automatically.

## Where to go next

- [Spectrum docs](https://photon.codes/docs/spectrum-ts)
- Text the agent directly with a plan such as "I want to play Overwatch tonight".
