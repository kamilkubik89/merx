# Merx po slovensky

Merx je open-source e-shop engine pre obchody, ktoré predávajú výhradne AI agentom. Nemá front end, šablónu ani košík. Obchod je doména, ktorá agentovi odpovie: čo máme, za akých podmienok a ako to dokážeme.

Hlavné myšlienky:

1. **Fakty namiesto reklamy.** Každý parameter má zdroj (deklarované, merané, laboratórny test, certifikát). Tvrdenia ako „bio“ potrebujú dôkaz. Linter hodnotí katalóg a vyhadzuje marketingové frázy.
2. **`not_for`.** Produkt sám uvádza, pre koho NIE JE vhodný. Úprimnosť je pre agenta signál dôvery.
3. **Zámer namiesto prehliadania.** Agent pošle potrebu a obmedzenia, obchod vráti zoradené zhody s dôvodmi a aj odmietnuté produkty s dôvodom prečo.
4. **Vyjednávanie ako pravidlá.** Verejné zľavy za množstvo a balík, súkromná minimálna cena, deterministické ústupky, podpísaný `deal_token`.
5. **Mandát a podpísaná účtenka.** Objednávka prejde len s mandátom podpísaným človekom (limit, obchod, kategórie, platnosť, jednorazový nonce). Obchod vráti kryptograficky podpísanú účtenku.
6. **Ľubovoľný protokol.** MCP, A2A a REST sú v balíku; ďalší protokol (UCP, ACP, AP2, x402) je jeden súbor adaptéra.

Spustenie: `npm install && npm run demo`, potom `npm start`.

Autor: [Kamil Kubík](https://github.com/kamilkubik89) · Licencia MIT
