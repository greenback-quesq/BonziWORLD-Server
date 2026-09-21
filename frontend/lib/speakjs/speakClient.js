(function (window, undefined) {
	// Use the correct document accordingly with window argument
	var document = window.document;
	
	// Define a local copy of speak
	var speak = {};
	
	// Map over speak in case of overwrite
	var _speak = window.speak;
	
	// Runs speak.js in no conflict mode, returning the original 'speak'
	// variable to its owner. Returns a reference to this speak object.
	speak.noConflict = function () {
		window.speak = _speak;
		return speak;
	}
	
	/* Cross-Browser Web Audio API Playback With Chrome And Callbacks */
	// from http://www.masswerk.at/mespeak/
	
	// alias the Web Audio API AudioContext-object
	var aliasedAudioContext = window.AudioContext || window.webkitAudioContext;
	// ugly user-agent-string sniffing
	var isChrome = ((typeof navigator !== 'undefined') && navigator.userAgent &&
	navigator.userAgent.indexOf('Chrome') !== -1);
	var chromeVersion = (isChrome) ?
	parseInt(
		navigator.userAgent.replace(/^.*?\bChrome\/([0-9]+).*$/, '$1'),
		10
	) : 0;
	
	// set up a BufferSource-node
	var audioContext = new aliasedAudioContext();
	
	// Web Worker
	var speakWorker;
	try {
		// https://github.com/yoshi6jp/speak.js/commit/b85d385024f1e20818aa9e3b272c86aa9fc2ebe6
		speakWorker = new Worker(document.querySelector('script[src$="speakClient.js"]').getAttribute('src').replace(/speakClient.js$/, 'speakWorker.js'));
	} catch (e) {
		console.log('speak.js warning: no worker support');
	}
	
	speak.play = function (text, args, onended, onstart) {
		var source = audioContext.createBufferSource();

		source.stopOld = source.stop;
		source.stop = function() {
			this.stopOld();
			if (this.endTimeout) clearTimeout(this.endTimeout);
		};

		var PROFILE = 1;
		
		function startSource(source) {
			if (source.start) {
				source.start(0);
			} else {
				source.noteOn(0);
			}
			if (onstart) onstart(source);
		}
		
		function playSound(streamBuffer) {
			source.connect(audioContext.destination);
			// since the ended-event isn't generally implemented,
			// we need to use the decodeAudioData()-method in order
			// to extract the duration to be used as a timeout-delay
			audioContext.decodeAudioData(streamBuffer, function (audioData) {
				// detect any implementation of the ended-event
				// Chrome added support for the ended-event lately,
				// but it's unreliable (doesn't fire every time)
				// so let's exclude it.
				if (!isChrome && source.onended !== undefined) {
					// we could also use "source.addEventListener('ended', callback, false)" here
					source.onended = onended;
				} else {
					var duration = audioData.duration;
					// convert to msecs
					// use a default of 1 sec, if we lack a valid duration
					var delay = (duration) ? Math.ceil(duration * 1000) : 1000;
					source.endTimeout = setTimeout(onended, delay);
				}
				// finally assign the buffer
				source.buffer = audioData;
				// start playback for Chrome >= 32
				// please note that this would be without effect on iOS, since we're
				// inside an async callback and iOS requires direct user interaction
				if (chromeVersion >= 32) startSource(source)
			},
			function(error) { /* decoding-error-callback */ }
		);
			// normal start of playback, this would be essentially autoplay
			// but is without any effect in Chrome 32
			// let's exclude Chrome 32 and higher to avoid any double calls anyway
			if (!isChrome || chromeVersion < 32) {
				startSource(source);
			}
		}
		
		function loadMp3Encoder() {
			if (window.lamejs) return Promise.resolve(window.lamejs);
			if (window.__speakMp3Loader) return window.__speakMp3Loader;
			window.__speakMp3Loader = new Promise(function (resolve, reject) {
				var script = document.createElement('script');
				script.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js';
				script.onload = function () {
					window.lamejs ? resolve(window.lamejs) : reject(new Error('lamejs did not load'));
				};
				script.onerror = reject;
				document.head.appendChild(script);
			});
			return window.__speakMp3Loader;
		}

		function wavToMp3(wav, lamejs) {
			var view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
			if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
				throw new Error('speak.js generated an invalid WAV');
			}
			var channels = view.getUint16(22, true);
			var sampleRate = view.getUint32(24, true);
			var offset = 12;
			var dataOffset = -1;
			var dataLength = 0;
			while (offset + 8 <= view.byteLength) {
				var chunk = view.getUint32(offset, false);
				var length = view.getUint32(offset + 4, true);
				if (chunk === 0x64617461) {
					dataOffset = offset + 8;
					dataLength = Math.min(length, view.byteLength - dataOffset);
					break;
				}
				offset += 8 + length + (length % 2);
			}
			if (dataOffset < 0) throw new Error('WAV data chunk is missing');

			var encoder = new lamejs.Mp3Encoder(channels, sampleRate, 64);
			var samplesPerFrame = 1152;
			var mp3Data = [];
			for (var position = 0; position < dataLength / 2; position += samplesPerFrame) {
				var left = new Int16Array(samplesPerFrame);
				var right = channels > 1 ? new Int16Array(samplesPerFrame) : left;
				for (var i = 0; i < samplesPerFrame; i++) {
					var samplePosition = position + i;
					if (samplePosition * 2 >= dataLength) break;
					left[i] = view.getInt16(dataOffset + samplePosition * 2, true);
					if (channels > 1 && samplePosition * 4 + 2 < dataLength) {
						right[i] = view.getInt16(dataOffset + samplePosition * 4 + 2, true);
					}
				}
				var encoded = channels > 1 ? encoder.encodeBuffer(left, right) : encoder.encodeBuffer(left);
				if (encoded.length) mp3Data.push(encoded);
			}
			var finalFrame = encoder.flush();
			if (finalFrame.length) mp3Data.push(finalFrame);
			return new Blob(mp3Data, { type: 'audio/mpeg' });
		}

		function handleWav(wav) {
			var startTime = Date.now();
			var wavBytes = new Uint8Array(wav);
			loadMp3Encoder().then(function (lamejs) {
				var mp3 = wavToMp3(wavBytes, lamejs);
				return mp3.arrayBuffer();
			}).then(function (buffer) {
				playSound(buffer);
				if (PROFILE) console.log('speak.js: MP3 processing took ' + (Date.now() - startTime).toFixed(2) + ' ms');
			}).catch(function (error) {
				console.warn('speak.js: MP3 compression unavailable; playing WAV', error);
				var buffer = new ArrayBuffer(wavBytes.length);
				buffer = wavBytes.buffer.slice(wavBytes.byteOffset, wavBytes.byteOffset + wavBytes.byteLength);
				playSound(buffer);
			});
		}

		speak.compressWavToMp3 = function (wav) {
			return loadMp3Encoder().then(function (lamejs) {
				return wavToMp3(new Uint8Array(wav), lamejs);
			});
		};
		
		if (args && args.noWorker) {
			// Do everything right now. speakGenerator.js must have been loaded.
			var startTime = Date.now();
			var wav = generateSpeech(text, args);
			if (PROFILE) console.log('speak.js: processing took ' + (Date.now() - startTime).toFixed(2) + ' ms');
			playSound(wav);
		} else {
			// Call the worker, which will return a wav that we then play
			var startTime = Date.now();
			speakWorker.onmessage = function (event) {
				if (PROFILE) console.log('speak.js: worker processing took ' + (Date.now() - startTime).toFixed(2) + ' ms');
				handleWav(event.data);
			};
			speakWorker.postMessage({ text: text, args: args });
		}
	};
	
	// Expose speak to the global object
	window.speak = speak;
})(window);
