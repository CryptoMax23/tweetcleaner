import os
import sys
import json
import webbrowser
import tweepy
from dotenv import load_dotenv

load_dotenv()

CONSUMER_KEY    = os.getenv("CONSUMER_KEY")
CONSUMER_SECRET = os.getenv("CONSUMER_SECRET")
STATE_FILE      = ".oauth_state.json"

if len(sys.argv) == 1:
    # Etape 1 : generer l'URL et sauvegarder le request token
    handler = tweepy.OAuth1UserHandler(CONSUMER_KEY, CONSUMER_SECRET, callback="oob")
    url = handler.get_authorization_url()

    with open(STATE_FILE, "w") as f:
        json.dump({
            "oauth_token":        handler.request_token["oauth_token"],
            "oauth_token_secret": handler.request_token["oauth_token_secret"],
        }, f)

    print("\nOuvre ce lien et connecte-toi avec @jordandebelfort :\n")
    print(url)
    webbrowser.open(url)
    print("\nUne fois autorise, Twitter affiche un code PIN. Donne-le moi.")

elif len(sys.argv) == 2:
    # Etape 2 : echanger le PIN contre les access tokens
    pin = sys.argv[1].strip()

    with open(STATE_FILE) as f:
        state = json.load(f)

    handler = tweepy.OAuth1UserHandler(CONSUMER_KEY, CONSUMER_SECRET, callback="oob")
    handler.request_token = state

    access_token, access_token_secret = handler.get_access_token(pin)

    print(f"\nACCESS_TOKEN={access_token}")
    print(f"ACCESS_TOKEN_SECRET={access_token_secret}")

    # Mise a jour du .env
    with open(".env", "r") as f:
        lines = f.readlines()
    with open(".env", "w") as f:
        for line in lines:
            if line.startswith("ACCESS_TOKEN_SECRET="):
                f.write(f"ACCESS_TOKEN_SECRET={access_token_secret}\n")
            elif line.startswith("ACCESS_TOKEN="):
                f.write(f"ACCESS_TOKEN={access_token}\n")
            else:
                f.write(line)

    os.remove(STATE_FILE)
    print("\nTokens sauvegardes dans .env — pret a supprimer les tweets.")


print("\nTokens enregistres dans .env — tu peux maintenant lancer delete_tweets.py")
