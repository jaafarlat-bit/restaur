# Menu digital pour restaurants

## Lancer en local
    npm install
    npm start
Ouvrir http://localhost:3000 : créer un compte restaurant, ajouter des plats et des photos.
Le menu des clients est sur /r/<lien-du-restaurant> (le QR code est dans la gestion).

## Mettre en ligne
- Hébergez ce dossier sur un serveur Node.js (Render, Railway, VPS...), en HTTPS.
- PORT : fourni par l'hébergeur.
- DATA_DIR : dossier persistant qui contient db.json et les photos. Sauvegardez-le.
- SECRET (facultatif) : clé de signature des sessions.
