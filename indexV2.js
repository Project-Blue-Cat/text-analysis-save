'use strict';

const config = require('./config.json');

// Get a reference to the Pub/Sub component
const pubsub = require('@google-cloud/pubsub')();
// Get a reference to the Cloud Storage component
const storage = require('@google-cloud/storage')();
// Get a reference to the Cloud Vision API component
const vision = require('@google-cloud/vision')();
// Get a reference to the Translate API component
const translate = require('@google-cloud/translate')();

const Buffer = require('safe-buffer').Buffer;

/**
 * Publishes the result to the given pubsub topic and returns a Promise.
 *
 * @param {string} topicName Name of the topic on which to publish.
 * @param {object} data The message data to publish.
 */
function publishResult (topicName, data) {
    return pubsub.topic(topicName).get({ autoCreate: true })
        .then(([topic]) => topic.publish(data));
}

/**
 * Cloud Function triggered by Cloud Storage when a file is uploaded.
 *
 * @param {object} event The Cloud Functions event.
 * @param {object} event.data A Google Cloud Storage File object.
 */
exports.processImage = function processImage (event) {
    let file = event.data;

    return Promise.resolve()
        .then(() => {
            if (file.resourceState === 'not_exists') {
                // This was a deletion event, we don't want to process this
                return;
            }

            if (!file.bucket) {
                throw new Error('Bucket not provided. Make sure you have a "bucket" property in your request');
            }
            if (!file.name) {
                throw new Error('Filename not provided. Make sure you have a "name" property in your request');
            }

            file = storage.bucket(file.bucket).file(file.name);
            console.log("finding image safety XXXXXXXXXXXXXXXXX");
            findImageSafety(file);

            return detectText(file);
        })
        .then(() => {
            console.log(`File ${file.name} processed.`);
        });
};

/**
 * Detects the text in an image using the Google Vision API.
 *
 * @param {object} file Cloud Storage File instance.
 * @returns {Promise}
 */
function detectText (file) {
    let text;

    console.log(`Looking for text in image ${file.name}`);
    return vision.detectText(file)
        .then(([_text]) => {
            if (Array.isArray(_text)) {
                text = _text[0];
            } else {
                text = _text;
            }
            console.log(`Extracted text from image : (${text} )`);

            return translate.detect(text);
        })
        .then(([detection]) => {
            const messageData = {
                text: text,
                filename: file.name,
                from: detection.language
            };

            console.log(`result to be published is (${messageData.text}`);
            console.log(`file name to be published is (${messageData.filename}`);
            return publishResult(config.RESULT_TOPIC, messageData);
        });

    return Promise.resolve()
}

/**
 * Detects the different image characteristics to determine if the image has inappropriate content.
 *
 * @param {object} file Cloud Storage file instance
 * @returns {Promise}
 */
function findImageSafety (file) {
    const likelihoods = ['UNKNOWN', 'VERY_UNLIKELY', 'UNLIKELY', 'POSSIBLE', 'LIKELY', 'VERY_LIKELY'];

    vision.detectSafeSearch(file)
        .then((results) => {

            const detections = results[1].responses[0].safeSearchAnnotation;

            console.log(`Adult: ${detections.adult}`);
            console.log(`Spoof: ${detections.spoof}`);
            console.log(`Medical: ${detections.medical}`);
            console.log(`Violence: ${detections.violence}`);

        })
        .catch((err) => {
            console.error('Vision API failure when finding image safety', err);
        })

    return Promise.resolve();
}

/**
 * Appends a .txt suffix to the image name.
 *
 * @param {string} filename Name of a file.
 * @param {string} lang Language to append.
 * @returns {string} The new filename.
 */
function renameImageForSave (filename) {
    return `${filename}.txt`;
}


/**
 * Saves the data packet to a file in GCS. Triggered from a message on a Pub/Sub
 * topic.
 *
 * @param {object} event The Cloud Functions event.
 * @param {object} event.data The Cloud Pub/Sub Message object.
 * @param {string} event.data.data The "data" property of the Cloud Pub/Sub
 * Message. This property will be a base64-encoded string that you must decode.
 */
exports.saveResult = function saveResult (event) {
    const pubsubMessage = event.data;
    const jsonStr = Buffer.from(pubsubMessage.data, 'base64').toString();
    const payload = JSON.parse(jsonStr);

    return Promise.resolve()
        .then(() => {
            if (!payload.text) {
                throw new Error('Text not provided. Make sure you have a "text" property in your request');
            }
            if (!payload.filename) {
                throw new Error('Filename not provided. Make sure you have a "filename" property in your request');
            }
            // if (!payload.lang) {
            //     throw new Error('Language not provided. Make sure you have a "lang" property in your request');
            // }

            console.log(`Received request to save file ${payload.filename}`);

            const bucketName = config.RESULT_BUCKET;
            const filename = renameImageForSave(payload.filename);
            const file = storage.bucket(bucketName).file(filename);

            console.log(`Saving result to ${filename} in bucket ${bucketName}`);

            return file.save(payload.text);
        })
        .then(() => {
            console.log(`File saved.`);
        });
};
