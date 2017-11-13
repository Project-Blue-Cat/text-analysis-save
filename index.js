'use strict';
const config = require('./config.json');

// Get a reference to the Pub/Sub component
const pubsub = require('@google-cloud/pubsub')();
// Get a reference to the Cloud Storage component
const storage = require('@google-cloud/storage')();
// Get a reference to the Cloud Vision API component
const language = require('@google-cloud/language').v1beta2();

const Buffer = require('safe-buffer').Buffer;

// /**
//  * Publishes the result to the given pubsub topic and returns a Promise.
//  *
//  * @param {string} topicName Name of the topic on which to publish.
//  * @param {object} data The message data to publish.
//  */
// function publishResult(topicName, data) {
//     return pubsub.topic(topicName).get({autoCreate: true})
//         .then(([topic]) => topic.publish(data));
// }

/**
 * Cloud Function triggered by Cloud Storage when a file is uploaded.
 *
 * @param {object} event The Cloud Functions event.
 * @param {object} event.data A Google Cloud Storage File object.
 */
exports.processText = function processText(event) {
    let file = event.data;

    console.log("attempting to process text");

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

            return runNaturalLanguageProcessing(file);
        })
        .then(() => {
            console.log(`File ${file.name} processed.`);
        });
}

/**
 * Detects various different properties using the Google Vision API.
 *
 * @param {object} file Cloud Storage File instance.
 * @returns {Promise}
 */
function runNaturalLanguageProcessing(file) {
    let text;

    // console.log("file name is " + file.name );

    //@TODO : this is probably a bad way to get the file. GEt the document and pass it through
    const docuemnt = {
        gcsContentUri: `gs://` + config.TEXT_BUCKET + `/` + file.name,
        type: 'PLAIN_TEXT'
    };

    return language.analyzeSentiment({document: docuemnt})
        .then((results) => {
            console.log("results");
            console.log(results);
            const sentiment = results[0].documentSentiment;
            console.log(`Document sentiment:`);
            console.log(`  Score: ${sentiment.score}`);
            console.log(`  Magnitude: ${sentiment.magnitude}`);

            // const sentences = results[0].sentences;
            // sentences.forEach((sentence) => {
            //     console.log(`Sentence: ${sentence.text.content}`);
            //     console.log(`  Score: ${sentence.sentiment.score}`);
            //     console.log(`  Magnitude: ${sentence.sentiment.magnitude}`);
            // });

            var messageData = {
                magnitude: sentiment.magnitude,
                score: sentiment.score,
                entities: []
            };

            return messageData;

        })
        .then((messageData) => {
            return processEntities(docuemnt, messageData);
        })
        // /** Safe Search Detection on image */
        // .then((documentData) => {
        //
        //     return findImageSafety(image, documentData);
        // })
        // /** Label Detection */
        // .then((documentData) => {
        //     return findLabels(image, documentData);
        // })
        // .then((documentData) => {
        //     return findFaces(image, documentData)
        // })
        /** Publish the image */
        .then((messageData) => {
            console.log("message data");
            console.log(messageData);
            return publishResult(config.TEXT_RESULT_TOPIC, messageData);
        });

    return Promise.resolve();
}

// function processSyntax(document, messageData) {
//     return language.analyzeSyntax({ document: document })
//         .then((results) => {
//             const syntax = results[0];
//
//             console.log('Tokens:');
//             syntax.tokens.forEach((part) => {
//                 console.log(`${part.partOfSpeech.tag}: ${part.text.content}`);
//                 console.log(`Morphology:`, part.partOfSpeech);
//             });
//         })
//         .catch((err) => {
//             console.error("ERROR:", err);
//         });
//
//     return Promise.resolve();
// }


function processEntities(document, messageData) {

    return language.analyzeEntitySentiment({document: document})
        .then((results) => {
            const entities = results[0].entities;

            console.log('Entities:');
            entities.forEach((entity) => {
                console.log("Entity");
                console.log(entity);
                console.log(entity.name + " mag : " + entity.sentiment.magnitude + " score : " + entity.sentiment.score);

                // var magnitude = entity.sentiment.magnitude;
                // var score = entity.sentiment.score;

                messageData.entities.push(entity);


            });

            return messageData;
        }).catch((err) => {
            console.error('ERROR:', err);
        });

    return Promise.resolve();
}


/**
 * Appends a .txt suffix to the image name.
 *
 * @param {string} filename Name of a file.
 * @param {string} lang Language to append.
 * @returns {string} The new filename.
 */
function renameImageForSave(filename) {
    return `${filename}Processed.txt`;
}

function saveAll(file, payload) {
    console.log(payload);

    var entitiesString = "";

    (payload.entities).forEach(entity => {
        var magnitude = entity.sentiment.magnitude;
        var score = entity.sentiment.score;
        var name = entity.name;

        //@TODO : consider changing to 0.3 but look at ads to check.
        if (score > 0) {
            if (score > 0.5 && magnitude > 0) {
                //Clearly Positive
                entitiesString += "\nClearlyPositive" + name;

            } else {
                //Positive
                entitiesString += "\nPositive" + name;
            }
        }
        else if (score < 0) {
            if (score < 0.5 && magnitude > 0) {
                //Clearly negative
                entitiesString += "\nClearlyNegative" + name;

            } else {
                //Negative
                entitiesString += "\nNegative" + name;
            }
        }
        else {
            //Neutral
            entitiesString += "\nNeutral" + name;
        }


    });

    file.save(entitiesString);

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
exports.saveResult = function saveResult(event) {
    const pubsubMessage = event.data;
    const jsonStr = Buffer.from(pubsubMessage.data, 'base64').toString();
    const payload = JSON.parse(jsonStr);
    console.log("in save result");
    return Promise.resolve()
        .then(() => {

            if (!payload.filename) {
                throw new Error('Filename not provided. Make sure you have a "filename" property in your request');
            }

            const bucketName = config.RESULT_BUCKET;
            const filename = renameImageForSave(payload.filename);

            console.log("trying to save : " + filename);

            const file = storage.bucket(bucketName).file(filename);

            console.log(`Saving result to ${filename} in bucket ${bucketName}`);

            return saveAll(file, payload);

        })
        .then(() => {
            console.log(`File saved.`);
        });
};
