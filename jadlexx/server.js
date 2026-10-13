
require("dotenv").config();

const express = require("express");
const session = require("express-session");

const app = express();
const PORT = process.env.PORT || 3000;

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_TOKEN,
  DISCORD_REDIRECT_URI,
  SESSION_SECRET
} = process.env;

const required = {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  DISCORD_TOKEN,
  DISCORD_REDIRECT_URI,
  SESSION_SECRET
};

for (const [key, value] of Object.entries(required)) {
  if (!value) {
    console.error(`Missing environment variable: ${key}`);
    process.exit(1);
  }
}

const API = "https://discord.com/api/v10";

app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    name: "jalexa.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 10 * 60 * 1000
    }
  })
);

const metadataSchema = [
  {
    key: "jalexa_verified",
    name: "Jalexa Verified",
    description: "Has completed Jalexa Discord verification",
    type: 7
  }
];

async function discordRequest(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.text();

  if (!response.ok) {
    throw new Error(
      `Discord API error ${response.status}: ${body}`
    );
  }

  return body ? JSON.parse(body) : null;
}

// Register the metadata field used by Linked Roles.
async function registerMetadata() {
  await discordRequest(
    `${API}/applications/${DISCORD_CLIENT_ID}/role-connections/metadata`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bot ${DISCORD_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(metadataSchema)
    }
  );

  console.log("Jalexa Linked Role metadata registered.");
}

app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Jalexa Verification</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #232428;
          color: white;
          display: grid;
          place-items: center;
          min-height: 100vh;
          margin: 0;
        }
        main {
          text-align: center;
          background: #313338;
          padding: 32px;
          border-radius: 16px;
          max-width: 420px;
          margin: 20px;
        }
        a {
          display: inline-block;
          background: #5865f2;
          color: white;
          text-decoration: none;
          padding: 13px 22px;
          border-radius: 8px;
          font-weight: bold;
        }
        p { line-height: 1.5; color: #dbdee1; }
      </style>
    </head>
    <body>
      <main>
        <h1>Jalexa</h1>
        <h2>Linked Roles Verification</h2>
        <p>Connect your Discord account to complete verification.</p>
        <a href="/linked-role">Verify with Discord</a>
      </main>
    </body>
    </html>
  `);
});

// Start the Discord OAuth2 authorization flow.
app.get("/linked-role", (req, res) => {
  const state = require("crypto").randomBytes(24).toString("hex");

  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: DISCORD_REDIRECT_URI,
    scope: "identify role_connections.write",
    state
  });

  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// Discord sends the user back here after authorization.
app.get("/discord-oauth-callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      return res.status(400).send(
        "Discord authorization was cancelled or denied."
      );
    }

    if (
      !code ||
      !state ||
      !req.session.oauthState ||
      state !== req.session.oauthState
    ) {
      return res.status(400).send(
        "Invalid verification state. Please start again."
      );
    }

    delete req.session.oauthState;

    // Exchange the authorization code for an access token.
    const tokenResponse = await fetch(`${API}/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: DISCORD_REDIRECT_URI
      })
    });

    const tokens = await tokenResponse.json();

    if (!tokenResponse.ok) {
      throw new Error(
        `Token exchange failed: ${JSON.stringify(tokens)}`
      );
    }

    // Get the Discord user who authorized Jalexa.
    const user = await discordRequest(`${API}/users/@me`, {
      headers: {
        Authorization: `Bearer ${tokens.access_token}`
      }
    });

    // Update the user's Linked Role connection.
    await discordRequest(
      `${API}/users/@me/applications/${DISCORD_CLIENT_ID}/role-connection`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          platform_name: "Jalexa",
          platform_username: user.username,
          metadata: {
            jalexa_verified: true
          }
        })
      }
    );

    res.type("html").send(`
      <!doctype html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Jalexa Verified</title>
      </head>
      <body style="font-family:Arial;text-align:center;padding:50px">
        <h1>Verification complete!</h1>
        <p>Your Discord account has been connected to Jalexa.</p>
        <p>Return to Discord to check your Linked Role.</p>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("Verification failed:", error.message);
    res.status(500).send(
      "Verification failed. Check the server logs and try again."
    );
  }
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", app: "Jalexa" });
});

app.listen(PORT, () => {
  console.log(`Jalexa server listening on port ${PORT}`);

  registerMetadata().catch((error) => {
    console.error(
      "Metadata registration failed:",
      error.message
    );
  });
});
