import os
import time
import json
import tweepy
from dotenv import load_dotenv

load_dotenv()

BEARER_TOKEN        = os.getenv("BEARER_TOKEN")
CONSUMER_KEY        = os.getenv("CONSUMER_KEY")
CONSUMER_SECRET     = os.getenv("CONSUMER_SECRET")
ACCESS_TOKEN        = os.getenv("ACCESS_TOKEN")
ACCESS_TOKEN_SECRET = os.getenv("ACCESS_TOKEN_SECRET")

PROGRESS_FILE = ".deleted_ids.json"

client = tweepy.Client(
    bearer_token=BEARER_TOKEN,
    consumer_key=CONSUMER_KEY,
    consumer_secret=CONSUMER_SECRET,
    access_token=ACCESS_TOKEN,
    access_token_secret=ACCESS_TOKEN_SECRET,
    wait_on_rate_limit=True,
)


def load_progress():
    if os.path.exists(PROGRESS_FILE):
        with open(PROGRESS_FILE) as f:
            return set(json.load(f))
    return set()


def save_progress(deleted_ids):
    with open(PROGRESS_FILE, "w") as f:
        json.dump(list(deleted_ids), f)


def get_my_user_id():
    me = client.get_me()
    return me.data.id


def delete_tweets_from_api(user_id):
    deleted_ids = load_progress()
    deleted = len(deleted_ids)
    pagination_token = None

    print(f"Recuperation des tweets via l'API... ({deleted} deja supprimes precedemment)")
    while True:
        response = client.get_users_tweets(
            id=user_id,
            max_results=100,
            pagination_token=pagination_token,
        )

        if not response.data:
            break

        for tweet in response.data:
            tid = str(tweet.id)
            if tid in deleted_ids:
                continue
            try:
                client.delete_tweet(tweet.id)
                deleted += 1
                deleted_ids.add(tid)
                print(f"  Supprime ({deleted}) : [{tweet.id}] {tweet.text[:60]}")
                if deleted % 10 == 0:
                    save_progress(deleted_ids)
                time.sleep(1)
            except tweepy.TweepyException as e:
                print(f"  Erreur sur {tweet.id} : {e}")

        save_progress(deleted_ids)
        meta = response.meta or {}
        pagination_token = meta.get("next_token")
        if not pagination_token:
            break

    return deleted


def delete_tweets_from_archive(archive_path):
    deleted_ids = load_progress()
    already = len(deleted_ids)

    with open(archive_path, "r", encoding="utf-8") as f:
        raw = f.read()
    raw = raw.split("= ", 1)[1]
    tweets = json.loads(raw)

    deleted = already
    errors  = 0

    print(f"Archive chargee : {len(tweets)} tweets trouves. ({already} deja supprimes)")
    for item in tweets:
        tweet_id = item["tweet"]["id"]
        if tweet_id in deleted_ids:
            continue
        text = item["tweet"]["full_text"][:60]
        try:
            client.delete_tweet(tweet_id)
            deleted += 1
            deleted_ids.add(tweet_id)
            print(f"  Supprime ({deleted}) : [{tweet_id}] {text}")
            if deleted % 10 == 0:
                save_progress(deleted_ids)
            time.sleep(1)
        except tweepy.TweepyException as e:
            errors += 1
            # Tweet deja supprime = normal, on l'ignore
            if "404" in str(e) or "not found" in str(e).lower():
                deleted_ids.add(tweet_id)
            else:
                print(f"  Erreur sur {tweet_id} : {e}")

    save_progress(deleted_ids)
    return deleted - already, errors


if __name__ == "__main__":
    print("=== Suppression de tous les tweets ===\n")

    if not ACCESS_TOKEN or "COLLE_TON" in ACCESS_TOKEN:
        print("ERREUR : remplis ACCESS_TOKEN et ACCESS_TOKEN_SECRET dans le fichier .env")
        exit(1)

    user_id = get_my_user_id()
    print(f"Compte connecte — user_id : {user_id}\n")

    archive = "tweets.js"

    if os.path.exists(archive):
        print(f"Archive detectee — utilisation de l'archive.\n")
        deleted, errors = delete_tweets_from_archive(archive)
        print(f"\nTermine. Supprimes : {deleted} | Erreurs : {errors}")
    else:
        print("Suppression via l'API (max ~3200 tweets les plus recents).\n")
        deleted = delete_tweets_from_api(user_id)
        print(f"\nTermine. Supprimes : {deleted}")
        print("Quand tu recois l'archive Twitter, place tweets.js ici et relance le script pour supprimer le reste.")
