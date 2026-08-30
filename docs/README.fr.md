# RedCall Live Translate — documentation française

RedCall Live Translate est une extension Chrome Manifest V3 qui traduit en temps réel l’audio d’un
onglet choisi par l’utilisateur. Le mode bidirectionnel remplace également la piste microphone
envoyée par Google Meet, Zoom Web ou Telegram Web par la voix traduite.

Ce dépôt contient le **client Chrome** présenté à des fins de portfolio et de revue technique. L’API
RedCall et le worker de traduction restent des services séparés. Aucune clé fournisseur ni aucun
secret serveur ne sont présents dans le dépôt.

## Compétences techniques démontrées

- Architecture Chrome Manifest V3 : service worker, Side Panel API, document offscreen et content
  scripts.
- Authentification Authorization Code + PKCE et renouvellement de session côté client.
- Audio WebRTC temps réel transporté par LiveKit.
- Traitement Web Audio : filtre passe-haut, égalisation, compression, limiteur et ducking
  automatique.
- Interception contrôlée des pistes WebRTC des applications de réunion.
- Comportement _fail closed_ : en cas de panne de traduction, le microphone brut n’est pas réinjecté
  silencieusement.
- Gestion complète du cycle de vie : arrêt des pistes, timers, contextes audio et salles
  temporaires.
- Validation automatisée du manifeste, de la CSP, des permissions, des ressources et des motifs de
  secrets.

## Compatibilité

| Mode            | Cible                               | État                                    |
| --------------- | ----------------------------------- | --------------------------------------- |
| Écouter traduit | Tout onglet Chrome avec audio       | Implémenté                              |
| Deux sens       | Google Meet                         | Implémenté                              |
| Deux sens       | Zoom Web et sous-domaines régionaux | Bêta, appel réel à valider              |
| Deux sens       | Telegram Web K et A                 | Bêta, clients à tester séparément       |
| Écouter traduit | WhatsApp Web                        | Pris en charge par la capture générique |

WhatsApp Web reste volontairement exclu du mode bidirectionnel dans cette version.

## Installation locale

Prérequis : Chrome 116+, Node.js 22+ pour les contrôles du dépôt, un compte RedCall et une API
RedCall compatible.

Clonez ce dépôt, puis exécutez :

```bash
cd redcall-live-translate
npm ci
npm run validate
```

Ensuite :

1. Ouvrir `chrome://extensions`.
2. Activer le **Mode développeur**.
3. Cliquer sur **Charger l’extension non empaquetée** et sélectionner la racine du dépôt.
4. Épingler **RedCall Live Translate**.
5. Ouvrir l’onglet à traduire et cliquer sur l’icône de l’extension.
6. Se connecter à RedCall, choisir les langues et démarrer la session.

Le serveur par défaut est `https://redcall.tech/redcall-api`. Une API compatible différente peut
être définie dans les options avancées du panneau.

## Sécurité et confidentialité

- Le mot de passe est saisi sur le domaine RedCall, jamais dans l’extension.
- Les clés OpenAI, ElevenLabs et LiveKit restent côté serveur.
- Les jetons navigateur sont courts, limités à une salle et à un rôle.
- La capture commence uniquement après une action explicite de l’utilisateur.
- Cette fonctionnalité ne réalise aucun enregistrement audio et ne persiste aucun transcript côté
  client.

Pour le détail des composants et des frontières de confiance, consulter
[architecture.md](architecture.md) et [SECURITY.md](../SECURITY.md).
