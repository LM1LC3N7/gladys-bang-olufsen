// -----------------------------------------------------------------------------
// The texts users read in Gladys (configuration buttons, connection status),
// in English and French.
// -----------------------------------------------------------------------------

const both = (en, fr) => ({ en, fr });
const list = (items) => items.join(', ');

export const T = {
  found: (lines) =>
    lines.length === 0
      ? both(
          'No Bang & Olufsen Mozart product found. Type the IP address of each product in the configuration (the search cannot cross every network). Older BeoLink products are not supported.',
          "Aucun produit Bang & Olufsen Mozart trouvé. Saisissez l'adresse IP de chaque produit dans la configuration (la recherche ne traverse pas tous les réseaux). Les anciens produits BeoLink ne sont pas pris en charge.",
        )
      : both(
          `Found: ${list(lines)}. Create them from the Discovery tab.`,
          `Trouvés : ${list(lines)}. Créez-les depuis l'onglet Découverte.`,
        ),
  noProduct: both(
    'No product known yet: type their IP addresses in the configuration, or use "Find the products".',
    'Aucun produit connu : saisissez leurs adresses IP dans la configuration, ou utilisez « Chercher les produits ».',
  ),
  check: (lines) => ({
    en: lines.map((l) => l.en).join(' · '),
    fr: lines.map((l) => l.fr).join(' · '),
  }),
  checkLine: (label, reading) => {
    if (reading.on === true) {
      const volume = Number.isInteger(reading.volume) ? reading.volume : '?';
      const power =
        reading.power === true
          ? both('on', 'allumé')
          : reading.power === false
            ? both('in standby', 'en veille')
            : both('power unknown', 'alimentation inconnue');
      return both(
        `${label}: answers, ${power.en}, volume ${volume}`,
        `${label} : répond, ${power.fr}, volume ${volume}`,
      );
    }
    if (reading.on === false) {
      return both(
        `${label}: no answer (off or unreachable)`,
        `${label} : ne répond pas (éteint ou injoignable)`,
      );
    }
    return both(`${label}: unexpected answer`, `${label} : réponse inattendue`);
  },
  unreachable: (names) =>
    both(
      `Not answering (off or unreachable), asked again at spaced intervals: ${list(names)}.`,
      `Ne répondent pas (éteints ou injoignables), redemandés à intervalles espacés : ${list(names)}.`,
    ),
  addressUnknown: (names) =>
    both(
      `Address unknown (another product answers at the old one): ${list(names)}. Run "Find the products" or type the new address; a search also runs by itself every 10 minutes.`,
      `Adresse inconnue (un autre produit répond à l'ancienne) : ${list(names)}. Lancez « Chercher les produits » ou saisissez la nouvelle adresse ; une recherche se lance aussi d'elle-même toutes les 10 minutes.`,
    ),
  noAnswerAt: (addresses) =>
    both(
      `No Mozart product answers yet at: ${list(addresses)}.`,
      `Aucun produit Mozart ne répond encore à : ${list(addresses)}.`,
    ),
  notMozart: (addresses) =>
    both(
      `Something answers at ${list(addresses)}, but not the Mozart API: older BeoLink products (Beoplay, BeoSound Core, Essence…) are not supported.`,
      `Quelque chose répond à ${list(addresses)}, mais pas l'API Mozart : les anciens produits BeoLink (Beoplay, BeoSound Core, Essence…) ne sont pas pris en charge.`,
    ),
  invalidEntries: (entries) =>
    both(
      `Ignored in the configuration (invalid): ${list(entries)}.`,
      `Ignorés dans la configuration (invalides) : ${list(entries)}.`,
    ),
  dataReset: both(
    'The saved product list was unreadable and was reset; the products are found again from their addresses.',
    'La liste enregistrée des produits était illisible et a été réinitialisée ; les produits sont retrouvés par leurs adresses.',
  ),
};
