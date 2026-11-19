# Delicioso: ordering + admin dashboard

Requires **Node.js 22.13+** (nothing else to install).

```
cd dilicioso
node server.js
```
(Windows PowerShell: open the folder, type the two lines above. Keep the window open while the site runs.)

For a fresh checkout, copy `.env.example` to `.env`, then set a strong `ADMIN_PASSWORD` and a restricted `GOOGLE_MAPS_API_KEY` before the first start. Never commit `.env`.

- Customers: http://localhost:3000
- Staff: http://localhost:3000/admin   (initial password: `admin`)

## Settings (optional environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `ADMIN_PASSWORD` | `admin` | Initial admin password for a new database. Change it in the admin dashboard before putting the site online. |
| `GOOGLE_MAPS_API_KEY` | Empty | Google Maps JavaScript API and Places key for delivery search. |
| `PORT` | `3000` | Port |
| `DB_FILE` | `dilicioso.db` | Database file (orders, customers, menu) |
| `UPLOAD_DIR` | `./uploads` | Where dish photos are stored |

PowerShell example for the initial password: `$env:ADMIN_PASSWORD="my-strong-password"; node server.js`. After initialization, the password is stored as a salted hash in the database and can be changed from the admin dashboard's **Sécurité** tab.

Copy `.env.example` to `.env` and add your own Google Maps key. The delivery map and address/place suggestions use the Google Maps JavaScript API and Places API (New). Enable both APIs in Google Cloud Console and restrict the key to your site referrers and these APIs. Never commit `.env`; the provided `.gitignore` excludes it. The key from Google's demo-key page is for testing/prototyping only; use a restricted project key with billing configured before launch.
Address and business suggestions appear as the customer types at least three characters (debounced by 450 ms). Selecting a result fills the address and moves the pin to that place. Place Autocomplete sessions are used to group typing and selection requests for billing.

## What it does
- **Browsing is free:** anyone can see the menu and fill a cart without an account.
- **Ordering needs an account:** at checkout the customer creates an account (name, phone, password) or logs in. Orders are linked to the account and customers only see the status of their own orders.
- **Service status:** the admin **Réglages** tab sets opening hours per weekday, a pause switch with an optional message, delivery zones/fees and pickup. When no weekday hours are configured, every day defaults to 08:00–23:59 (the admin can edit this at any time). Checkout is blocked when closed or paused and the banner shows the next opening time. Prices, fees and totals are always recomputed on the server.
- **Dish info:** each dish can carry a portion (`portion`), allergens and dietary tags, plus a free-text special request per cart line (up to 120 characters). The allergen and dietary lists are managed by the staff in the **Réglages** tab (rename, add or remove options); the menu editor and the customer menu then use the updated lists.
- **Orders:** live orders (new orders appear with a beep) flow pending → accepted → preparing → ready → out for delivery (delivery only) → completed, with cancel. Staff can filter by status, mode, date range and a text search, adjust each order's ETA, confirm before cancelling, print a kitchen ticket (printing never changes the status) and export the filtered list to CSV.
- **Insights:** the Ventes tab shows top-selling dishes and currently unavailable dishes for the selected period, alongside the existing revenue chart.
- **Customer history:** signed-in customers have a "Mes commandes" page listing their last orders with reorder and live tracking.
- **Table reservations:** signed-in customers request a table from the "Réserver" page (live calendar, time slots, inside/outside seating); a guest is shown a sign-in/register box first. Same-day requests are flagged "phone verification required", future ones await admin review. A customer may hold only one active booking at a time — the "Réserver" page reopens for a new table once the previous one is finished (date/time passed, or the admin marked it completed/cancelled/rejected). A booking is private to the account that made it (plus the phone used to book it), and the customer can change their own booking afterwards — changes send it back for approval (the admin sees "Modifiée par le client") and the customer's page updates live over SSE.
- **Dish photos:** the Italian menu uses local stock photos in `public/photos/`; new photos chosen in the admin form are saved in `uploads/`. Back up `uploads/` together with `dilicioso.db`.
- **Delivery destination:** customers choose a delivery zone when zones are configured; they can also use their current location or a point on Google Maps. The address, zone and coordinates are stored with the order, and staff can open the pin from the admin dashboard. Location access requires customer permission and HTTPS on a public site.

## Notes
- The Italian menu (17 dishes and drinks) is loaded from `seed.json` when the database is empty.
- Customer logins last 30 days and survive restarts. Admin login lasts 12 hours and is reset when the server restarts.
- For a public site: use HTTPS (Caddy, nginx or a host such as Render/Railway), a strong admin password, and a persistent disk for `dilicioso.db` and `uploads/`.
- GitHub stores the source code; GitHub Pages cannot run this Node.js server or its SQLite database. Deploy the app to a Node.js host with persistent storage when you want the site online.
