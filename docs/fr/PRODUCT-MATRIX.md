# Matrice de dimensions produit + Utilisateur idéal (avec la variable prix/performance DeepSeek)

<!-- doc-version: 1.0 -->
> **Version du document 1.0** · Traduction française · Mis à jour le 2026-06-27 · Source faisant autorité : [English](../PRODUCT-MATRIX.md). En cas de divergence entre la traduction et la version anglaise, la version anglaise prévaut.

> Date d'archivage : 2026-06-21. Ce document enregistre deux **matrices de comparaison au niveau produit** (une table de forces, une table de faiblesses, réalisées le matin du 2026-06-21) et y attache un jugement : « du point de vue de l'utilisateur, quel type d'utilisateur avec un **vrai besoin non satisfait aujourd'hui** nous convient le mieux » — tenant délibérément compte de la variable externe que « la nouvelle API de DeepSeek au cours des deux derniers mois a fortement amélioré le rapport prix/performance des LLM ».
>
> Lecture complémentaire : [`COMPETITIVE-LANDSCAPE.md`](../COMPETITIVE-LANDSCAPE.md) (l'enquête panoramique du 2026-05-29 sur 30+ projets sur toutes les pistes). Ce document est la « carte des pistes » ; celui-ci est « comparaison tête-à-tête au niveau produit + utilisateur cible ». Les cases dans les deux matrices sont des **jugements grossiers au niveau du positionnement produit** (basés sur des matériaux publics), pas des tests point par point ; la vérification précise d'un seul fournisseur peut être approfondie séparément.

---

## 1. Matrice des forces : produit × dimension (AipeHub dans la dernière ligne)

> ✅ possède · ⚠️ partiel / niveau payant uniquement / niveau primitif · ❌ aucun / pas ce positionnement. Les dimensions sont **choisies selon la posture de conception d'AipeHub** — son avantage ici est donc structurel, avec un « avantage à domicile » (la matrice des faiblesses prend les dimensions dont se préoccupent vraiment les acheteurs d'entreprise, et l'écart s'inverse immédiatement).

| Produit représentatif | OSS | Auto-hébergé | Possède données/creds | Gouvernance·audit·RBAC | Approbation HITL | Fédération inter-organisations | Continuité personnel↔org | Le framework ne fait pas tourner le LLM |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| **Salesforce Agentforce** | ❌ | ❌ | ❌ | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| **Microsoft** Copilot Studio/Agent 365 | ❌ | ❌ | ⚠️ | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| **ServiceNow** AI Agents | ❌ | ❌ | ❌ | ✅ | ✅ | ⚠️ | ❌ | ❌ |
| **Google** Gemini Enterprise | ❌ | ❌ | ❌ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ |
| **LangGraph** | ✅ | ✅ | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| **CrewAI** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| **MS Agent Framework** (SDK) | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ⚠️ | ❌ | ❌ |
| **n8n** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ |
| **Dify** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| **Flowise** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ❌ |
| **Temporal / Windmill** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ❌ | ❌ | ⚠️ |
| **Odysseus** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Goose** (Block) | ✅ | ✅ | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| **OpenClaw / Hermes** (classe) | ✅ | ✅ | ✅ | ❌ | ⚠️ | ❌ | ❌ | ❌ |
| **🟢 AipeHub** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Glossaire des dimensions** : fédération inter-organisations = agents de hubs/organisations souverains différents collaborant (les credentials restent chez eux) ; continuité personnel↔org = une seule pile qui passe en douceur du mode personnel à l'équipe puis à l'inter-organisations ; le framework ne fait pas tourner le LLM = le framework ne fait que router/comptabiliser, ne décide jamais pour les participants (le Hub est simple).

**Comment lire ce tableau** :
- Les **trois colonnes les plus à droite** (fédération inter-organisations / personnel↔org / framework ne fait pas tourner le LLM) **sont ✅ uniquement pour AipeHub**, tout le monde étant ❌/⚠️ — c'est le vrai espace blanc d'AipeHub.
- Les plateformes commerciales (4 premières lignes) : excellentes notes en gouvernance/HITL, mais **OSS·auto-hébergement·possession-des-données sont tous ❌** (SaaS, le fournisseur détient le modèle de confiance ; certains offrent VPC mais c'est quand même de la location au fond).
- Les frameworks OSS / plateformes auto-hébergées (7 lignes du milieu) : excellentes notes en OSS·auto-hébergement, mais **gouvernance seulement ⚠️, inter-organisations tous ❌** (au sein d'une seule org).
- Les agents personnels (OpenClaw/Hermes/Goose/Odysseus) : excellentes notes en auto-hébergement, mais **gouvernance·inter-organisations·chemin de continuité tous ❌** (une seule personne, une seule machine).
- **AipeHub est la seule ligne entièrement verte** — mais précisément parce que les dimensions ont été choisies selon sa posture, la table des faiblesses ci-dessous doit être lue en parallèle.

---

## 2. Matrice des faiblesses : comparaison inverse honnête (inverser les dimensions dont se préoccupent les acheteurs d'entreprise, et AipeHub est le plus faible)

Le tableau ci-dessus gagne sur « l'avantage à domicile ». Inversez les dimensions qu'un acheteur d'entreprise pose vraiment, et l'écart s'inverse immédiatement :

| Dimension | Qui est fort (produit spécifique) | AipeHub |
|---|---|---|
| Validation client / échelle | Salesforce Agentforce (8000+ clients), ServiceNow | ❌ en phase initiale / usage propre |
| Intégration écosystème (CRM/ITSM/Office/SAP) | Salesforce, ServiceNow, Microsoft | ❌ à câbler soi-même via MCP |
| Certifications de conformité (SOC2/ISO/HIPAA) | toutes les plateformes commerciales | ❌ aucune certification |
| Maturité out-of-box / no-code | n8n, Dify, Agentforce | ⚠️ nécessite configuration / example-first |
| Modèle fort intégré + SLA + support commercial | toutes les plateformes commerciales | ❌ (et par conception ne fait pas tourner le modèle ; dépend du MiMo/DeepSeek/Claude que vous branchez) |
| Maturité de l'orchestration visuelle | n8n, Flowise, Dify | ⚠️ principalement YAML déclaratif (vue DAG en lecture seule ajoutée) |

**Faiblesse d'effet de réseau (listée séparément, car c'est une question de vie ou de mort pour les produits de type fédération)** : la valeur de la fédération croît de façon supralinéaire avec le nombre de pairs, alors qu'au démarrage à froid le nombre de pairs = 0. C'est le piège mortel de tout produit « inter-organisations » — §4 ci-dessous explique pourquoi les utilisateurs cibles que nous choisissons **apportent leurs propres pairs et peuvent contourner ce piège**.

---

## 3. Conclusion en une ligne

**AipeHub n'est pas « un meilleur Agentforce » ni « un n8n plus puissant » ; il occupe une case carrefour qu'aucun autre n'occupe** : souveraineté auto-hébergée + fédération inter-organisations + gouvernance/HITL au niveau org + un chemin de continuité personnel-vers-org + le framework ne fait pas tourner le LLM. Le prix en est que c'est un produit en phase initiale sur « maturité / écosystème / conformité / validation client » — là où précisément les plateformes commerciales sont les plus solides.

> Sources de données : panorama fournisseurs vdf.ai / guerres de plateformes Futurum / couche protocole Zylos / auto-hébergement OSS Knowlee / HITL Strata, plus mesures de la base de code (32 packages / 85,7k LOC / ratio de tests >1:1 / 41 démos). Voir [`COMPETITIVE-LANDSCAPE.md`](../COMPETITIVE-LANDSCAPE.md).

---

## 4. Quel type d'utilisateur nous convient le mieux — « a un besoin, mais pas satisfait aujourd'hui »

Superposez les deux matrices et **les cases servies sont déjà encombrées ; il n'y a qu'une seule case non servie** :

> **Les petites organisations qui ont besoin de gouvernance / tutelle / approbation + souveraineté des données + collaboration transfrontalière, mais ① ne peuvent pas se permettre et ne peuvent pas utiliser les plateformes d'entreprise, et ② sont aussi bloquées par le plafond « mono-organisation, sans gouvernance » des frameworks OSS.**

Cette case est presque vide aujourd'hui — non pas parce que personne ne veut la construire, mais parce qu'elle est bloquée par **deux murs à la fois** :

- **Mur A (prix/maturité)** : les plateformes d'entreprise (Agentforce/ServiceNow/Microsoft/Google) ont la gouvernance et le HITL, mais ont un ACV élevé, un GTM SaaS à forte implication et **ne descendent tout simplement pas** vers un foyer, un bubble-tea shop, un cabinet d'avocats à trois personnes.
- **Mur B (architecture)** : les frameworks OSS (LangGraph/Dify/n8n) et les agents personnels (OpenClaw/Goose) sont suffisamment bon marché et auto-hébergeables, mais **n'ont architecturalement pas de fédération inter-organisations, pas de gouvernance au niveau org, pas de porte d'approbation sortante** — et aucune quantité de bon marché ne fait pousser ces capacités.

AipeHub se tient juste dans la fissure entre les deux murs : il possède la « gouvernance + HITL + souveraineté des données » des plateformes d'entreprise, et aussi l'« auto-hébergement + bon marché + credentials sur votre machine » des frameworks OSS, **plus il possède exclusivement ces trois colonnes (fédération inter-organisations / continuité personnel↔org / framework ne fait pas tourner le LLM)**.

### 4.1 Les deux têtes de pont les plus nettes, dont nous avons déjà construit les exemples

| Tête de pont | Qui | Pourquoi pas satisfait aujourd'hui | Les exemples que nous avons construits |
|---|---|---|---|
| **A. Famille / éducation** | parents ouvrant l'IA aux enfants, IA familiale souveraine multi-membres, tutelle parentale + approbation | les plateformes d'entreprise ne vendent pas aux familles ; les agents personnels sont mono-personne/mono-machine sans tutelle/souveraineté inter-membres/porte d'approbation | `family-learning-hub` (deux hubs souverains + porte d'approbation sortante + verrouillage des données enfants par classe), le tuteur `/teach`, fork de transcription vers le parent |
| **B. PME inter-organisations** | chaîne d'approvisionnement (boutique↔fournisseur), chaînes franchisées (QG↔magasin), mentorat/clubs/projets inter-entreprises | les plateformes d'entreprise sont trop lourdes/chères pour les très petites structures, et leur histoire inter-organisations reste liée au fournisseur ; les frameworks OSS sont mono-organisation | `tea-supply-link`, `tea-chain-hq`, `warband-club`, `cafe-ops` |

En poussant d'un anneau vers l'extérieur, la même case contient aussi les **fédérations de petites équipes réglementées** : consortiums de cabinets d'avocats, cliniques, appels d'offres inter-entreprises, collaboration de recherche — toutes « collaboration inter-organisations + les données doivent rester dans mes propres mains + besoin d'audit/approbation », également non servies de front aujourd'hui.

### 4.2 DeepSeek a franchi le « mur du prix » — exactement la variable que l'utilisateur a pointée

Le jugement de l'utilisateur tient pleinement : **un produit qui n'avait pas de cas de rapport prix/performance avant pourrait en avoir un plus tard.** Le mécanisme, explicité :

1. **Cette case était historiquement bloquée par une double contrainte** : ① le LLM est trop cher + ② aucun produit ne comble « souveraineté + gouvernance + inter-organisations + prix consommateur ». Les familles ne peuvent pas se le permettre, les bubble-tea shops ont des marges minces, et « faire tourner le LLM sur chaque interaction, plus garder plusieurs agents actifs pour le routage/consultation/heartbeat » **ne rentrait pas dans les calculs** aux anciens prix des modèles — donc ce genre d'IA auto-hébergée avec gouvernance est restée coincée au stade démo, sans que personne passe vraiment en production.
2. **La nouvelle API de DeepSeek au cours des deux derniers mois supprime la contrainte ①** (coût LLM). **AipeHub comble exactement la contrainte ②** (le produit manquant). Mettez les deux ensemble et cette case, pour la première fois, a à la fois « abordable » et « quelque chose à utiliser ».
3. **L'asymétrie clé — les concurrents peuvent utiliser DeepSeek bon marché aussi, mais les LLM bon marché ne les aident pas à atteindre cette case** :
   - Les plateformes d'entreprise : un LLM bon marché ne change pas leur GTM d'entreprise à forte implication ; ils **ne** descendront **pas** pour vendre aux familles/petites boutiques juste pour économiser des tokens.
   - Les frameworks OSS : un LLM bon marché **ne peut pas ajouter** de fédération inter-organisations/gouvernance/HITL — une baisse de prix ne comble pas ce que l'architecture n'a pas.
   - Les agents personnels : un LLM bon marché **ne peut pas ajouter** tutelle/inter-organisations/approbation — ils sont mono-personne/mono-machine par conception.
   - → DeepSeek est une marée montante qui soulève tout le monde, mais elle **débloque de façon disproportionnée la case d'AipeHub** : parce que cette case était bloquée par « coût ∧ produit manquant » à la fois, DeepSeek supprime le coût, et **seul AipeHub fournit le produit manquant**.
4. **Et les LLM bon marché profitent plus à AipeHub qu'aux autres** — un point méconnu : la conception d'AipeHub « le framework ne fait pas tourner le LLM, mais les participants le font » génère naturellement **de nombreux petits appels LLM** (un agent de routage décidant à qui dispatcher, la consultation multi-agents, les réveils proactifs heartbeat, les agents de croissance trois-piliers, tuteur+filtre-sujet+modération-contenu…). Cette forme « de nombreux participants LLM bon marché » était une **charge de coûts** aux anciens prix des modèles — exactement ce qui gardait les utilisateurs non-entreprise dehors ; une fois que DeepSeek baisse le prix unitaire, la conception la plus naturelle d'AipeHub devient le **meilleur rapport prix/performance** — et c'est avantageux précisément sur les utilisateurs que le prix avait exclus auparavant.

### 4.3 Pourquoi ce choix résout aussi commodément le piège « démarrage à froid de la fédération »

§2 a dit : le plus grand piège mortel pour les produits de type fédération est **nombre de pairs = 0**. Les deux têtes de pont que nous choisissons **apportent leurs propres pairs** :

- « parent + enfant » représente **2 hubs souverains** dès le premier mouvement ;
- « boutique + fournisseur », « QG + franchise », « maître + apprenti » représentent **≥2 parties** dès le premier mouvement.

En d'autres termes, le **scénario d'utilisation** de ce type d'utilisateur est lui-même **une fédération en paire/groupe** — le deuxième pair n'est pas quelque chose que l'on doit aller chercher en BD, c'est apporté par le cas d'usage. C'est fondamentalement différent d'« une entreprise qui achète un seul déploiement » : un seul déploiement d'entreprise ne peut pas démarrer à froid un réseau de fédération, alors qu'une paire de familles ou une chaîne d'approvisionnement **apporte naturellement le deuxième nœud**. Choisir cette case c'est donc à la fois « le besoin le moins satisfait » et une façon de transformer le problème de démarrage à froid par effet de réseau de la fédération, de « piège mortel » à « apporté par le cas d'usage ».

### 4.4 Frontières honnêtes (ce n'est pas « gagner en pilote automatique »)

- **Le prix du mur A est surmonté, mais la « maturité » du mur A ne l'est pas** : les familles/petites boutiques veulent **vraiment out-of-box** (démarrage en une ligne, une coquille de bureau, onboarding infaillible) ; AipeHub est encore example-first + nécessite de la configuration. Le rapport prix/performance a débloqué la demande, **la facilité d'utilisation est la prochaine porte**.
- **La confiance/conformité est encore une porte difficile pour les familles et les petites équipes réglementées** : garder les données d'un enfant, un consortium de cabinets d'avocats — sans soutien d'audit/conformité ils n'oseront toujours pas l'utiliser.
- **La distribution est encore un problème commercial, pas un problème de code** : les utilisateurs de cette case sont éparpillés et difficiles à acquérir ; il faut une entrée no-code + une galerie de modèles + de vrais clients de référence, pas quelques fonctionnalités supplémentaires.

---

## 5. Une ligne pour la prise de décision

> **La cible la plus nette est la petite structure qui « a besoin de gouvernance/tutelle/inter-organisations, mais que les plateformes d'entreprise ne peuvent pas atteindre et que les frameworks OSS ne peuvent pas développer » — famille/éducation d'abord, collaboration PME inter-organisations ensuite.** Elles étaient historiquement bloquées à la fois par « le LLM est trop cher » et « il n'existe pas un tel produit » ; la baisse de prix de DeepSeek au cours des deux derniers mois a supprimé le premier, AipeHub est exactement la réponse au second, et le cas d'usage de ce type d'utilisateur **apporte son propre pair de fédération**, résolvant commodément le démarrage à froid. Les concurrents peuvent utiliser DeepSeek bon marché aussi, mais une baisse de prix ne peut pas combler la gouvernance inter-organisations que leur architecture n'a pas — **la fenêtre de rapport prix/performance de cette case est structurellement ouverte pour AipeHub.** Les combats difficiles restants se situent dans la facilité d'utilisation, le soutien de confiance et la distribution — pas dans la technologie.
