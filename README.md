This repository contains a few simple tools to help work with the wonderful [iNaturalist](inaturalist.org) project. The default iNaturalist web and mobile apps are great, but there were a few features I wanted to add. Ordinarily upstreaming such things would be great, but some of the changes I wanted are pretty dramatic on the interface, and I doubt they would be merged upstream.

- A [web interface](https://nebotron.github.io/inat-tools/explorer/) with deep-linking/sharing support that also renders decently on mobile.
- The ability to intersect "not observed by me" with other filters, like "recently observed".
- An interface which uses as much of the screen as possible for images to optimize for mobile devices.

There is also a *far* more experimental [auto-cropper](https://nebotron.github.io/inat-tools/cropper/). Expect crashes and bugs here. When it works, it provides:
- Computer vision based identification of the subject, and automatic cropping to it.
- When the CV fails, a nice interface to crop to the subject manually
- One-click share to iNaturalist on mobile

I am not accepting feature requests or bug reports, but I am accepting pull requests!
