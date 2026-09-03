# EcoFlow

Surveillez et contrôlez votre EcoFlow River 2 (et plus largement la gamme
River 2 : River 2 Max, River 2 Pro) directement dans Gladys, via l'API
officielle EcoFlow Open Platform — la même API cloud qu'utilise l'application
EcoFlow elle-même.

**Important : les appareils EcoFlow n'ont aucun mode de contrôle local/LAN.**
Même un appareil qui ne quitte jamais votre réseau WiFi est piloté via le
cloud EcoFlow, aussi bien par l'application officielle que par cette
intégration — confirmé par la position officielle d'EcoFlow (le contrôle
local sans internet n'est actuellement pas pris en charge pour cette gamme de
produits ; la seule exception dans tout le catalogue EcoFlow est l'EZ1, un
minuteur d'arrosage sans rapport). Votre appareil a besoin d'un accès
internet sur votre réseau pour que cette intégration fonctionne.

## Ce que vous obtenez

Un appareil Gladys est créé par appareil EcoFlow lié à votre compte. Chaque
appareil expose :

- **Niveau de batterie** (%)
- **Puissance de charge AC** (W) — puissance entrante par l'entrée secteur
- **Puissance de sortie totale** (W) — puissance sortante sur toutes les
  sorties combinées
- **Puissance de sortie AC** (W)
- **Puissance d'entrée solaire** (W) — depuis un panneau solaire connecté,
  le cas échéant
- **Sortie AC** (marche/arrêt)
- **X-Boost** (marche/arrêt) — permet à la sortie AC d'alimenter des
  appareils plus gourmands, au prix d'une onde sinusoïdale moins propre
- **Sortie DC (allume-cigare)** (marche/arrêt)
- **Réserve de secours** (marche/arrêt)

## Configuration

1. Créez un compte développeur gratuit et une paire Access Key/Secret Key sur
   [EcoFlow Open Platform](https://developer-eu.ecoflow.com/) (Europe) ou
   [developer.ecoflow.com](https://developer.ecoflow.com/) (international) —
   l'approbation peut prendre environ une semaine.
2. Ouvrez l'onglet **Configuration** de l'intégration et entrez votre Access
   Key et votre Secret Key, puis choisissez la région correspondante.
3. Enregistrez : tous les appareils de votre compte EcoFlow apparaissent
   dans l'onglet **Découverte**.

## Actions

- **Tester la connexion** — rafraîchit immédiatement un appareil donné et
  rapporte son niveau de batterie et sa puissance de sortie AC, ou l'erreur
  API exacte en cas d'échec.

## Suites possibles

Volontairement hors du périmètre de cette première version, listées ici
plutôt que simplement omises :

- **Push MQTT en temps réel** à la place du sondage périodique — l'Open
  Platform EcoFlow propose ce mécanisme (le même point d'accès
  `/certification` que cette intégration pourrait réutiliser), mais la forme
  exacte d'un message poussé reste à confirmer sur un compte réel avant de
  pouvoir remplacer la boucle de sondage actuelle.
- **Réglages numériques de limite de charge/décharge et de niveau de réserve
  de secours** (les pourcentages que l'application EcoFlow permet de régler)
  — la catégorie de fonctionnalité `battery-storage` de Gladys n'a pas de
  type « niveau cible » distinct du capteur de niveau de batterie lui-même :
  cela nécessite soit un ajout au cœur de Gladys, soit une réutilisation
  délibérée (et clairement documentée) d'un type existant.

## Testé et confirmé

État honnête, pour que ce que « ça fonctionne » recouvre réellement soit
clair — **aucun compte développeur EcoFlow ni appareil River 2 physique
n'étaient disponibles lors de l'écriture de cette intégration.**

- L'API REST (liste des appareils, instantané de quota, envoi de commande)
  et sa signature de requête HMAC-SHA256 sont écrites à la main et
  recoupées avec deux implémentations indépendantes et réellement utilisées,
  lues directement : le code `api/public_api.py` de l'intégration
  communautaire Home Assistant
  [`tolwi/hassio-ecoflow-cloud`](https://github.com/tolwi/hassio-ecoflow-cloud),
  et le code source `SignatureBuilder`/`RestClient` de
  [`rustyy/ecoflow-api`](https://github.com/rustyy/ecoflow-api) — non
  exécutées comme dépendance (voir plus bas), mais lues pour confirmer
  l'algorithme et les points d'accès.
- Les noms des champs de quota de la gamme River 2 (`pd.soc`,
  `inv.outputWatts`, `mppt.inWatts`...) et la forme des commandes
  (`acOutCfg`, `mpptCar`, `upsConfig`, `dsgCfg`, `watthConfig`) sont validés
  au moment de l'exécution par les schémas zod réels de
  [`@ecoflow-api/schemas`](https://www.npmjs.com/package/@ecoflow-api/schemas)
  — des schémas réels et à jour publiés par ce projet, pas une copie figée.
- **Un bug réel a été trouvé et contourné** : le paquet publié
  `@ecoflow-api/rest-client@0.6.0` plante à l'import pour tout consommateur
  (un chemin interne cassé qui ne peut jamais se résoudre). Cette intégration
  n'en dépend pas — la couche REST/signature est écrite à la main, et
  confirmée fonctionnelle par la suite de tests de ce dépôt.
- Ce qui n'est **pas** confirmé indépendamment : les valeurs exactes de
  `out_voltage`/`out_freq` qu'un vrai River 2 rapporte pour
  `mppt.cfgAcOutVol`/`mppt.cfgAcOutFreq` (utilisées pour compléter la
  commande de sortie AC en plus du champ que vous modifiez réellement), et
  le préfixe réel du numéro de série rapporté par l'appareil (un
  espace réservé a été utilisé dans les tests). Faites tourner cette
  intégration avec `LOG_LEVEL=debug` sur votre propre River 2 et ouvrez un
  ticket si une commande se comporte de façon inattendue.

## Dépannage

Consultez les logs de l'intégration depuis l'interface Gladys (ou
`docker logs` sur l'hôte) avec `LOG_LEVEL=debug` pour le détail complet de
chaque requête envoyée à l'API Cloud EcoFlow.
