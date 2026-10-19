# Bang & Olufsen

Pilotez depuis Gladys les produits **Bang & Olufsen** récents de la
plateforme **Mozart**, sur votre réseau local, sans aucun cloud : volume
(plafonné), sourdine, source, lecture, pause, suivant, précédent, le titre en
cours et la mise en veille. L'intégration utilise l'API locale officielle que
Bang & Olufsen publie pour ces produits (REST, et notifications en direct par
WebSocket), celle qu'utilise l'intégration Bang & Olufsen de Home Assistant.

> **Intégration non officielle, sans lien avec Bang & Olufsen.** Ce premier
> jalon a été écrit et testé uniquement contre un produit simulé : il n'a
> **jamais été testé avec un vrai produit**. Vos retours sont les bienvenus.

## Produits pris en charge

Seulement les produits de la plateforme **Mozart**, ceux que Bang & Olufsen
liste pour son API : Beosound Balance, Beosound Emerge, Beosound Level,
Beosound A5, Beosound A9 (5e génération), Beosound 2 (3e génération),
Beosound Theatre, Beosound Premiere, Beolab 8, Beolab 28 et Beoconnect Core.
Un téléviseur **Beovision** est piloté par sa partie Mozart (un Beosound
Theatre, par exemple) : le son (volume, source, lecture), pas l'image.

**Les anciens produits BeoLink ne sont pas pris en charge** : enceintes
Beoplay (A9 jusqu'à la 4e génération, M3, M5…), BeoSound Core, BeoSound
Essence, BeoSound 35, téléviseurs Beovision sans produit Mozart, et tous les
produits des plateformes « ASE » ou plus anciennes. Ils ne répondent pas à
l'API Mozart : le statut de l'intégration le dit pour une adresse où un tel
produit répond, et rien n'est ajouté.

## Préparer les produits

1. Installez les produits avec l'application Bang & Olufsen comme
   d'habitude (Wi-Fi ou Ethernet).
2. Donnez à chaque produit une **adresse IP fixe** dans votre box (bail DHCP
   réservé). L'adresse est visible dans l'application B&O, ou dans la liste
   des appareils de votre box.
3. Gladys doit joindre les produits sur le réseau : port 80 (API REST) et
   port 9339 (notifications).

## Ajouter un produit

- **Par son adresse** (conseillé) : saisissez l'adresse IP dans « Adresses IP
  des produits » (plusieurs adresses séparées par des virgules) et
  enregistrez.
- **Par la recherche** (facultatif) : utilisez **Chercher les produits**.
  Gladys parcourt le réseau (mDNS, service `_bangolufsen._tcp`) pour
  l'intégration. Un réseau qui bloque le multicast peut les cacher : saisissez
  alors l'adresse. La recherche n'est jamais nécessaire au reste.

Le produit apparaît dans l'onglet **Découverte** de l'intégration : créez-le.

## Ce que vous obtenez

Un appareil Gladys par produit :

| Fonction       | Détail                                                                          |
| -------------- | ------------------------------------------------------------------------------- |
| Alimentation   | Lecture seule : 1 allumé, 0 en veille (ou veille réseau), éteint ou injoignable |
| Veille         | Bouton : met le produit en veille                                               |
| Volume         | 0 à 100, lu et réglé (nombres entiers), plafonné par le volume maximal          |
| Sourdine       | Bouton : chaque appui lit la sourdine du produit et règle l'inverse             |
| Lecture, Pause | Boutons                                                                         |
| Suivant, Préc. | Boutons                                                                         |
| État lecture   | Lecture seule : 1 en lecture, 0 en pause, arrêté ou inactif                     |
| Source         | Liste, lue et réglée : les sources que ce produit a montrées (Spotify…)         |
| En cours       | Texte : « Artiste - Titre », ou « — » quand rien ne joue                        |

Les états arrivent **aussitôt** par les notifications du produit (volume
tourné sur le produit, morceau changé dans l'application B&O…), regroupés en
une mise à jour par seconde au plus ; tout l'état est aussi relu à
l'intervalle de rafraîchissement. Quand les notifications sont perdues, elles
sont rouvertes après 5 secondes, puis deux fois plus tard à chaque fois
(5 minutes au plus).

La liste « Source » montre les sources que le produit annonce activées et
jouables (Spotify, TIDAL, Deezer, radio, AirPlay, Chromecast, entrée ligne,
TV…). Une source vue une fois reste dans la liste ; en choisir une qui n'est
pas disponible à ce moment est refusé et rien n'est envoyé.

## Volume maximal

**Volume maximal** (1 à 100, **70** par défaut) est le volume le plus haut que
Gladys peut régler. Un volume plus haut demandé par une scène, le tableau de
bord ou un assistant vocal est ramené au plafond (le journal le dit), jamais
refusé. Le plafond est relu juste avant chaque commande de volume : un
plafond abaissé s'applique aussitôt. Il ne limite que ce que Gladys envoie :
l'application B&O, la télécommande et les boutons du produit ne sont pas
limités. Mettez 100 pour l'enlever.

## Veille, et mise en marche

L'API n'a **pas de « marche »** : l'alimentation est un état en lecture seule
et la veille un bouton, pas un interrupteur ; un « éteins tout » ne met donc
jamais les produits en veille, et un « allume tout » n'aurait rien à envoyer.
Un produit se réveille de lui-même quand on lui envoie de la musique
(AirPlay, Chromecast, Spotify…), ou depuis l'application B&O, sa
télécommande ou ses boutons.

Un produit en veille répond en général encore (veille réseau) : il est
affiché **0** avec son dernier volume. Un produit qui ne répond plus du tout
est affiché **0** aussi (éteint ou injoignable), le statut de l'intégration
le nomme, et il est redemandé de moins en moins souvent : après l'intervalle
de rafraîchissement, puis deux fois plus tard à chaque fois, 5 minutes au
plus. Un produit qui accepte la connexion puis ne dit rien est **inconnu** :
rien n'est publié.

## Un produit qui a changé d'adresse

Chaque produit est connu par son numéro de série (tiré de son identifiant
Beolink), pas par son adresse. Quand un autre produit répond à l'adresse d'un
produit créé, l'intégration n'y envoie jamais rien : le produit est affiché
**0**, le statut indique « adresse inconnue », et une recherche se lance
d'elle-même toutes les 10 minutes jusqu'à le retrouver. Une adresse fixe dans
la box l'évite.

## Commandes

Chaque commande reçoit sa réponse dans les 5 secondes qu'attend Gladys. Les
commandes vers un même produit partent une par une ; une commande qui ne peut
pas partir à temps est abandonnée, jamais envoyée en retard. Un volume qui
n'est pas un nombre entier de 0 à 100 (vide, 12,5, texte…) est refusé avant
tout envoi. Quand une commande a pu atteindre le produit sans être confirmée
à temps, Gladys affiche « envoyée, sans confirmation » et l'état est relu deux
secondes plus tard ; « rien n'a été envoyé » n'est dit que si aucune requête
de commande n'est partie.

## Réglages

- **Volume maximal** : voir plus haut.
- **Intervalle de rafraîchissement** : fréquence de relecture de tout l'état,
  de 10 à 300 secondes (30 par défaut).
- **Vérifier les produits** : interroge maintenant chaque produit connu et
  dit lesquels répondent, s'ils sont allumés, et leur volume.

## Vie privée et sécurité

L'intégration ne parle qu'aux produits, sur votre réseau local, en HTTP et
WebSocket simples (l'API n'offre rien d'autre). L'API n'a pas de mot de
passe, et l'intégration n'en demande aucun. Elle garde une liste des produits
connus (numéro de série, adresse, nom, sources) dans son dossier de données
(`/data`). Les réponses sont lues avec une limite de taille (64 Ko), les
notifications aussi (64 Ko chacune, 50 par seconde au plus), et seuls les
champs attendus sont gardés.

## Limites

- Réseau local seulement, produits Mozart seulement (voir plus haut).
- Pas de « marche », pas de regroupement multiroom (Beolink), pas de réglages
  sonores, pas de lecture de notifications dans cette première version.
- Jamais testé avec un vrai produit à ce jour.

## Crédits

Les endpoints et les modèles sont portés en JavaScript depuis
[mozart-api](https://github.com/bang-olufsen/mozart-open-api) (licence MIT),
publié par Bang & Olufsen. Bang & Olufsen, Beosound, Beolab, Beovision,
Beoconnect et BeoLink sont des marques de Bang & Olufsen, citées seulement
pour nommer les produits compatibles.
