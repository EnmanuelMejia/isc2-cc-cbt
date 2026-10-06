/* ============================================================
   Interstitium Labs — Certification Bootcamps: hub engine
   Vanilla JS, zero dependencies.

   The generator renders all 68 cards as static HTML with data
   attributes (data-group, data-vendor, data-search). This script adds
   client-side search + group/vendor filtering over those attributes —
   the hub works fully without JS, and gets faster with it.
   ============================================================ */
(function(){
'use strict';

function $(id){ return document.getElementById(id); }

function currentFilters(){
  var q = ($('hubSearch').value || '').trim().toLowerCase();
  var group = $('groupFilter').value || '';
  var vendor = $('vendorFilter').value || '';
  return { q: q, group: group, vendor: vendor };
}

function cardMatches(card, f){
  if (f.group && card.getAttribute('data-group') !== f.group) return false;
  if (f.vendor && card.getAttribute('data-vendor') !== f.vendor) return false;
  if (f.q && (card.getAttribute('data-search') || '').indexOf(f.q) < 0) return false;
  return true;
}

function applyFilters(){
  var f = currentFilters();
  var cards = document.querySelectorAll('.hub-card');
  var sections = document.querySelectorAll('.group-section');
  var visible = 0;

  for (var i = 0; i < cards.length; i++){
    var show = cardMatches(cards[i], f);
    cards[i].style.display = show ? '' : 'none';
    if (show) visible++;
  }
  /* hide group sections that have no visible cards */
  for (var s = 0; s < sections.length; s++){
    var any = false;
    var secCards = sections[s].querySelectorAll('.hub-card');
    for (var c = 0; c < secCards.length; c++){
      if (secCards[c].style.display !== 'none'){ any = true; break; }
    }
    sections[s].style.display = any ? '' : 'none';
  }

  var count = $('hubCount');
  if (count){
    count.textContent = visible === cards.length
      ? cards.length + ' bootcamps across ' + sections.length + ' tracks'
      : visible + ' of ' + cards.length + ' bootcamps match';
  }
  var empty = $('hubEmpty');
  if (empty) empty.style.display = visible ? 'none' : '';
}

function clearFilters(){
  $('hubSearch').value = '';
  $('groupFilter').value = '';
  $('vendorFilter').value = '';
  applyFilters();
}

function boot(){
  var search = $('hubSearch'), group = $('groupFilter'), vendor = $('vendorFilter');
  if (!search || !group || !vendor) return; /* static hub without filters */
  var t = null;
  search.addEventListener('input', function(){
    if (t) clearTimeout(t);
    t = setTimeout(applyFilters, 120);
  });
  group.addEventListener('change', applyFilters);
  vendor.addEventListener('change', applyFilters);
  var clear = $('hubClear');
  if (clear) clear.addEventListener('click', clearFilters);
  applyFilters();
}

if (document.readyState === 'loading')
  document.addEventListener('DOMContentLoaded', boot);
else
  boot();

})();
