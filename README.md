# Plan de Verano '26 — la cuadrilla

App para organizar los planes de verano del grupo: cada uno marca sus **días disponibles**, se ve la **disponibilidad del grupo**, cualquiera puede **proponer planes**, **apuntarse** a ellos y **crear votaciones**.

- **Backend:** Node.js + Express
- **Base de datos:** PostgreSQL
- **Frontend:** una sola página (sin build, sin frameworks)
- **Sin registro:** cada uno escribe su nombre y ya. Todo se sincroniza para todos en tiempo casi real (refresco cada 20 s).

Arranca con 6 planes precargados: DouGall's, Casa Poli, Barbacoa en La Moruca, Finde del BBK, Cuevas de Ramales y Snorkel en Punta Ballota.

---

## Desplegar en Railway (desde GitHub)

1. **Sube el proyecto a GitHub.** Desde esta carpeta:
   ```bash
   git init
   git add .
   git commit -m "Plan de verano"
   git branch -M main
   git remote add origin https://github.com/TU_USUARIO/plan-verano.git
   git push -u origin main
   ```

2. **Railway → New Project → Deploy from GitHub repo** y elige el repo. Railway detecta Node solo (usa `npm install` y `npm start`).

3. **Añade la base de datos:** dentro del proyecto, **+ New → Database → PostgreSQL**.

4. **Enlaza la base de datos al servicio de la app:** abre el servicio de la app → pestaña **Variables** → **New Variable**:
   - Nombre: `DATABASE_URL`
   - Valor: `${{Postgres.DATABASE_URL}}`  *(referencia al servicio Postgres; Railway lo autocompleta)*

5. **Genera el dominio público:** servicio de la app → **Settings → Networking → Generate Domain**.

6. Abre la URL. Verás los 6 planes. Esa URL es la que pegas en el WhatsApp del grupo.

> Los datos viven en PostgreSQL, así que sobreviven a los redeploys. La app arranca limpia (solo los 6 planes); las tablas se crean solas en el primer arranque.

---

## Probar en local (opcional)

Necesitas una base de datos PostgreSQL. Con una corriendo:

```bash
npm install
DATABASE_URL="postgres://usuario:clave@localhost:5432/planverano" npm start
# abre http://localhost:3000
```

---

## Endpoints

| Método | Ruta | Qué hace |
|--------|------|----------|
| GET    | `/api/data` | Todo el estado (planes + apuntados, disponibilidad, votaciones) |
| POST   | `/api/plans` | Proponer un plan nuevo |
| DELETE | `/api/plans/:id` | Borrar una propuesta (solo planes no fijos) |
| POST   | `/api/plans/:id/toggle` | Apuntarse / quitarse de un plan |
| POST   | `/api/availability` | Guardar los días disponibles de una persona |
| POST   | `/api/polls` | Crear una votación |
| POST   | `/api/options/:id/vote` | Votar / quitar voto de una opción |
| DELETE | `/api/polls/:id` | Borrar una votación |
