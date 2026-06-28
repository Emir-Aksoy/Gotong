# Politique de sécurité

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../../SECURITY.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

## Comment signaler une vulnérabilité

**Veuillez ne pas ouvrir une issue GitHub publique, une discussion ou une PR pour les
problèmes de sécurité.** Utilisez un canal privé :

### Préféré — Signalement privé de vulnérabilité GitHub

Ouvrez un avis privé à :

> **<https://github.com/Emir-Aksoy/AipeHub/security/advisories/new>**

Le formulaire intégré de GitHub vous offre :

- un fil privé de bout en bout avec les mainteneurs (pas de fuite par email)
- des pièces jointes + étapes de reproduction au même endroit
- une chronologie suivie du signalement → correction → attribution CVE publique

C'est le canal que nous lisons en premier et auquel nous répondons le plus rapidement.
Vous aurez besoin d'un compte GitHub gratuit ; c'est le seul prérequis.

### Pas de canal email (pré-1.0)

Il n'y a délibérément **pas d'email de sécurité** pendant la période v0.x.
`security@aipehub.dev` apparaît dans d'anciennes révisions de ce dépôt comme une
adresse *aspirationnelle* — le domaine n'est pas enregistré et la boîte aux lettres
n'est pas activée, donc les messages qui y sont envoyés n'arrivent nulle part. Nous
avons cessé de l'annoncer comme alternative plutôt que d'exposer un contact mort que
quelqu'un pourrait utiliser pour un vrai signalement.

Le signalement privé de vulnérabilité GitHub (ci-dessus) est le **seul** canal
aujourd'hui : gratuit, privé, et celui que nous lisons en premier. La question de savoir
si une vraie boîte aux lettres vaut la peine d'être mise en place est une décision de
[checklist de release](.github/RELEASE-CHECKLIST.md#security-contact) reportée à la
préparation de la 1.0 ; d'ici là, veuillez utiliser le formulaire d'avis.

Si vous ne pouvez vraiment pas utiliser GitHub, ouvrez une **Discussion GitHub non
sécuritaire** demandant à un mainteneur de vous contacter — sans aucun détail sur la
vulnérabilité — et nous organiserons un canal privé pour ce signalement.

Incluez dans votre avis :

- une description du problème
- des étapes de reproduction précises
- le hash du commit que vous avez testé (`git rev-parse HEAD`)
- (optionnel) une correction ou un patch proposé
- (optionnel) le nom / pseudonyme que vous souhaitez créditer dans l'avis

### Qu'en est-il de PGP ?

Nous ne **publions pas** de clé PGP aujourd'hui. Raisons :

- Le canal d'avis privé de GitHub est déjà chiffré TLS de bout en bout entre vous
  et la notification du mainteneur, donc PGP apporte peu.
- Maintenir une clé PGP pour un projet en début de vie représente plus de modes
  d'échec (clés perdues, clés expirées, cérémonies de signature) que de bénéfices.

Si la politique de votre organisation exige une divulgation chiffrée par PGP, veuillez
nous contacter via le canal GitHub d'abord et nous organiserons un échange PGP hors
bande pour ce signalement unique.

---

## Calendrier de réponse

| Phase | Objectif |
|---|---|
| Accusé de réception | dans les **72 heures** du signalement |
| Premier triage + évaluation de la gravité | dans les **7 jours** |
| Correction ou atténuation dans `main` | haute gravité : **7 jours**, moyenne : **30 jours**, faible : meilleur effort |
| Divulgation publique | **7–14 jours** après l'intégration de la correction (ou par accord mutuel) |

Vous recevrez une mise à jour à chaque transition. Si vous n'avez pas de nouvelles de
notre part dans la fenêtre d'accusé de réception de 72 heures, c'est en soi un bug —
veuillez escalader via une Discussion GitHub (générale, pas de contenu de sécurité), en
identifiant un mainteneur.

---

## Versions prises en charge

AipeHub est pré-1.0 en interne (les étiquettes v2.0 / v2.1 que vous voyez dans
`CHANGELOG.md` font référence à la génération de réécriture file-first, pas au seuil
SemVer 1.0). Nous corrigeons les problèmes de sécurité sur la branche `main` actuelle
uniquement. Il n'y a **pas de branche LTS**.

Si vous avez besoin d'une stabilité à long terme, épinglez à un commit que vous avez
audité et prévoyez des correctifs en place ; nous ne pouvons pas rétroportage
indéfiniment.

---

## Modèle de menace

AipeHub est conçu pour des déploiements **petits, de confiance, mono-locataire** —
un laboratoire de recherche, une équipe de projet, un petit groupe de prévisualisation
publique. Les valeurs par défaut supposent que la salle est exploitée par des personnes
qui se font confiance mutuellement.

Dans la portée (nous acceptons les signalements à propos de) :

- ✅ Accès non authentifié aux endpoints admin
- ✅ Divulgation de tokens / cookies (entre utilisateurs, entre salles, entre processus)
- ✅ Bugs de chiffrement / déchiffrement dans `secrets.enc.json` et le fichier de clé
  maître
- ✅ Contournement d'autorisation — par exemple, un worker atteignant des routes
  réservées aux admins
- ✅ CSRF / clickjacking / XSS dans l'interface admin bundlée
- ✅ Épuisement des ressources qui ne nécessite *aucune* authentification (DOS anonyme)
- ✅ Bugs d'analyse du protocole wire qui font planter l'hôte ou corrompent la
  transcription
- ✅ Escalade de privilèges dans le `TeamBridgeAgent` (par exemple, une équipe locale
  gagnant une visibilité imprévue sur l'upstream)
- ✅ Problèmes de deputy confus dans le chemin de spawn du LocalAgentPool / agent géré

Hors portée (faible priorité — les correctifs sont bienvenus, mais pas traités comme
sécurité) :

- ❌ **Admins non fiables.** Une fois qu'un compte détient le rôle admin, il peut
  faire tout ce que le rôle admin expose. Si vous avez besoin d'un pare-feu admin
  interne, ouvrez une demande de fonctionnalité.
- ❌ **DDoS couche applicative** par un utilisateur *authentifié*. La limitation de
  débit est par IP et se réinitialise au redémarrage ; pas une défense contre l'abus
  interne délibéré.
- ❌ **Grandes charges utiles de tâches** causant une pression mémoire. Pas encore de
  quotas.
- ❌ **Attaques de temporisation par canal auxiliaire** en dehors de la comparaison de
  tokens (la comparaison de tokens elle-même est en temps constant).
- ❌ Problèmes qui nécessitent un accès physique / shell à la machine hôte.
- ❌ Découvertes contre les sources en amont de `templates/community/` — ce sont des
  dépôts de prompts tiers sous leurs propres licences et gouvernance ; signalez-les
  directement à eux.

Si votre découverte se situe à la frontière, envoyez-la via le canal d'avis GitHub et
nous ferons le triage.

---

## Atténuations en place (pour que vous sachiez quelles défenses existent déjà)

Lors de l'évaluation d'un problème, vérifiez si l'une d'elles le couvre déjà :

- **Stockage des tokens** : les tokens admin / worker sont hachés avec SHA-256 avant
  d'être écrits sur disque. Le texte en clair est affiché exactement une fois à la
  création. La vérification utilise une comparaison en temps constant.
- **Stockage des cookies** : HttpOnly toujours ; `SameSite=Strict` + `Secure` quand
  `AIPE_COOKIE_SECURE=1` (requis derrière HTTPS).
- **CSRF** : `AIPE_ALLOWED_HOSTS` applique des vérifications `Host:` et `Origin:` sur
  chaque méthode changeant l'état. **Définissez-le sur chaque déploiement en
  production.** Non défini signifie « seul le loopback est sûr ».
- **Limitation de débit** : `AIPE_ADMIN_RATE_MAX` / `_SEC` plafonne les tentatives de
  vérification de token admin par IP par fenêtre glissante. Valeurs par défaut 10 / 60s.
- **En-têtes de sécurité** : `X-Frame-Options: DENY`, une CSP stricte,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` sur chaque réponse.
- **Contrôle d'admission** : `AIPE_GATING=admin-approval` (défaut) exige que chaque
  agent distant soit approuvé par un humain avant de rejoindre. `gating=open` est
  **dev uniquement** et est rejeté en production avec un avertissement au démarrage.
- **Chiffrement des clés API** : les clés API de workspace et par agent vivent dans
  `<space>/secrets.enc.json`, AES-256-GCM, clé maître dans
  `<space>/runtime/secret.key` (0600) ou variable d'env `AIPE_SECRET_KEY`. Le fichier
  chiffré seul ne suffit pas à récupérer les clés.
- **Liaison d'identité par agent (v0.4)** : `authenticate()` peut retourner
  `{ ok: true, allowedAgents: [...] }` pour qu'une clé API divulguée ne puisse pas
  usurper l'identité d'un agent arbitraire — seulement ceux auxquels elle est liée.
- **La transcription est append-only** : il n'y a pas d'API pour supprimer ou réécrire
  des entrées de transcription depuis le runtime. La falsification nécessite un accès au
  système de fichiers (hors portée ; voir « hors portée » ci-dessus).

---

## Divulgation coordonnée

Nous suivons la divulgation coordonnée standard :

1. Vous envoyez les détails en privé (canal d'avis GitHub préféré).
2. Les mainteneurs confirment, définissent la portée, développent et testent une
   correction.
3. La correction arrive sur `main` (et une branche de rétroport s'il y a un engagement
   LTS).
4. Divulgation publique 7–14 jours plus tard, avec :
   - un identifiant CVE (nous en demanderons un si approprié)
   - crédit à vous dans l'avis, sauf si vous demandez à rester anonyme
   - un résumé de l'impact + atténuation dans `CHANGELOG.md`

Si vous divulguez publiquement avant que nous ayons livré une correction, nous livrerons
quand même la correction, mais le champ de crédit de l'avis indiquera « non coordonné ».

---

## Checklist de sécurité pour les opérateurs

Si vous **exploitez** un hub, et non si vous signalez des bugs contre lui, la checklist
de durcissement côté déploiement se trouve dans
[`docs/DEPLOY.md` § "Liste de contrôle de production"](../../docs/DEPLOY.md#production-checklist).

En bref :

- [ ] `AIPE_COOKIE_SECURE=1` quand fronté par HTTPS
- [ ] `AIPE_ALLOWED_HOSTS` défini sur vos vrais noms d'hôtes
- [ ] `AIPE_GATING=admin-approval` (jamais `open` sur l'internet public)
- [ ] Caddy / nginx termine TLS ; backend lié à `127.0.0.1`
- [ ] `runtime/secret.key` (chmod 600) ou variable d'env `AIPE_SECRET_KEY` est définie
- [ ] Des sauvegardes existent pour le répertoire `<space>/`
- [ ] Au moins 2 comptes admin pour pouvoir récupérer un blocage
- [ ] `/healthz` surveillé

---

Merci de garder le projet honnête. La plupart des rapporteurs ne voient jamais ce qui
se trouve de l'autre côté d'un avis privé — mais chacun que nous recevons rend le
prochain déploiement un peu plus sûr.
