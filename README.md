# Supprimer anciens tweets

Préparez vos clés API X/Twitter et suivez les étapes ci-dessous.

Installation

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

Configurer les variables d'environnement

Définissez `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN` et `TWITTER_ACCESS_SECRET` dans votre environnement, ou créez un fichier `.env` à la racine contenant ces variables.

Obtenir les clés API

1. Allez sur https://developer.twitter.com/ (ou https://developer.x.com/) et connectez-vous.
2. Créez un projet/app et générez les clés API et tokens d'accès.
3. Copiez les valeurs dans votre `.env` ou exportez-les en variables d'environnement.

Exemple de fichier `.env`:

```
TWITTER_API_KEY=your_api_key_here
TWITTER_API_SECRET=your_api_secret_here
TWITTER_ACCESS_TOKEN=your_access_token_here
TWITTER_ACCESS_SECRET=your_access_secret_here
```

Pour charger un fichier `.env` spécifique, utilisez l'option `--env-file`:

```bash
python delete_tweets.py --username votre_username --env-file .env --dry-run
```

Exemples d'exécution

Dry-run (affiche ce qui serait supprimé):

```bash
python delete_tweets.py --username votre_username --dry-run
```

Suppression réelle:

```bash
python delete_tweets.py --username votre_username
```

Pour ne supprimer que les tweets avant une date:

```bash
python delete_tweets.py --username votre_username --before 2021-01-01T00:00:00
```
