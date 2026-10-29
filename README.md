# Oefenapp Koren Rolinde Zieverink

Luister naar een toon, zing hem na en zie meteen of je zuiver zit.

## Op je iPhone zetten

De microfoon werkt op iOS alleen via een beveiligd adres (https). Dubbelklikken op index.html werkt dus niet.

Gratis en snel:
1. Ga naar https://app.netlify.com/drop en sleep de hele map `Muziekapp` erop (of gebruik GitHub Pages / Cloudflare Pages).
2. Open het adres dat je krijgt in Safari op je iPhone.
3. Tik op Deel, dan "Zet op beginscherm". Open de app vanaf het beginscherm.
4. Tik op Start en sta de microfoon toe.

## Bestanden
- index.html: de hele app (toon, toonhoogte-detectie, weergave, feedback)
- manifest.webmanifest, sw.js, icons/: maken er een installeerbare app van die ook offline werkt
- make_icons.js: maakt de iconen opnieuw (alleen nodig bij een andere vormgeving)

## Hoe het werkt
- Toon: WebAudio, sinus met boventonen, een willekeurige toon binnen de gekozen stemgroep.
- Detectie: YIN-algoritme op het microfoonsignaal, nauwkeurig tot een paar cent.
- Oordeel: de toon moet ongeveer een seconde vastgehouden worden. Gemeten wordt de mediaan van de laatste halve seconde.
- Streng, Normaal of Ruim = ±20, ±35 of ±50 cent marge. Een octaaf hoger of lager mag standaard (uit te zetten).

## Koren en koorcodes
- Elk koor heeft een eigen code. De stukken van een koor staan versleuteld in de map `koren/` en zijn alleen met die code te openen.
- Open `beheer.html` op je site (bijvoorbeeld `.../beheer.html`) om een koor te starten, stukken toe te voegen en een pakket te maken.
- Zet het pakket in de map `koren` van deze map. De rest gaat vanzelf naar GitHub en online.
- De uitnodigingslink bevat de code (`#koor=...`). Zangers openen de link in Safari en zetten de app op hun beginscherm. In de app staat de code nog niet, dus ze vullen hem één keer in.
- Je kunt één persoon niet afsluiten. Wil je dat, maak dan een nieuw koor met een nieuwe code en verwijder de oude map in `koren/`.
