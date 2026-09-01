const externalLinks = document.querySelectorAll('a[href^="https://"]');

for (const link of externalLinks) {
  link.target = '_blank';
  link.rel = 'noreferrer noopener';
}
